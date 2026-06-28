# ZIRA Protocol Formalization

**Status: design specification for the public GitHub release and the fresh mainnet.**

This document formalizes the ZIRA protocol: it gives crisp definitions, invariants, and
formulas for each consensus-critical mechanism, states exactly what the current code does
(with file references), and separates what ships now (**SHIPPED 1.5.x**) from what is
deferred (**ROADMAP**, with rationale).

It is deliberately honest about weaknesses. A prior deep review surfaced several
sybil/economic/finality gaps; each is verified against the code below and made concrete as
a roadmap item, so the public reader sees both the property we claim and the gap we have
not yet closed.

Conventions used throughout:

- µZIR is the smallest unit; `1 ZIR = 1_000_000 µZIR` (`PROTOCOL.UZIR_PER_ZIR`).
- All times are wall-clock milliseconds unless noted. An *epoch* is `ACCOUNTING_ROUND_MS = 5000` ms (`constants.ts`).
- The *observation window* is `OBSERVATION_WINDOW_MS = 30000` ms.
- `ZTI(p, d)` is identity `p`'s ZIRA Trust Index in domain `d`, in `[0,1]`; `ZTI(p)` is its overall index.
- Source of truth for consensus math: `packages/protocol/src`. The node (`node/src`) drives it; the Console never holds anything consensus-critical (`docs/ARCHITECTURE.md`).

---

## 0. System model and trust assumptions

- **Participants** are ed25519 keypairs (`CRYPTO.CURVE = "ed25519"`, `crypto.ts`); an address is the `sha3-256`-derived 20-byte hash with the `zir` prefix.
- **Events** are signed `tx`, `observation`, and `lock` messages gossiped over libp2p, applied in canonical order to a deterministic state machine (`ledger/validate.ts`, `docs/ARCHITECTURE.md`).
- **State** is a set of account leaves `{address, balance, nonce}`, a supply tracker `{emitted, burned, reserve}`, the active founder set, and the 512 anchor seats. Its `sha3-256` digest is the **state root** (`consensus.computeStateRoot`).
- **Adversary.** We assume a Byzantine adversary that can create keypairs cheaply (today identity is free; see §1), submit any signed message, and control some fraction of trust weight. Honest nodes follow the rules and reproduce state independently. We do **not** assume an honest majority of *identities*; safety must rest on honest majority of *trust* and on every node enforcing validity locally.
- **Soft state vs consensus state.** Resonators, tasks, queries, answers, and model registry entries are *soft state* — gossiped, not in the state root (`SoftState.ts`, `resonators.ts`). Balances, nonces, supply, founders, and anchor seats are *consensus state*.

---

## 1. Proof of Resonance (PoR)

### Definition (Lock)

A **Lock** is the network's sealed answer for a `(subject, domain)` at an epoch. Let
`O = {o_1, …, o_n}` be the latest signed observation per distinct observer for a subject,
all with timestamps inside the trailing window `[epoch − WINDOW_ROUNDS + 1, epoch]`. Let
each observer `i` carry weight `w_i = ZTI(i, domain) · confidence_i` (domain ZTI, floored at
0.05 for a brand-new observer) and report `value_i`.

A Lock seals iff **all four** gates hold:

1. **Observation gate:** `n ≥ MIN_OBSERVATIONS` (= 3).
2. **Median exists:** the trust-weighted median `m` is defined (total weight > 0).
3. **Convergence gate:** `CV(values) < CV_THRESHOLD` (= 0.02), where `CV = stddev/|mean|`.
4. **Support gate:** `supportingTrust ≥ FINALITY_THRESHOLD` (= 0.67).

### Formulas

- **Trust-weighted median** (`field.trustWeightedMedian`): sort claims by `value`; `m` is the value at which cumulative weight first reaches `½ · Σ w_i`. A median (not a mean) does not move unless an attacker holds > 50% of the weight in the domain.
- **Coefficient of variation** (`field.cv`): `CV = sqrt( (1/n) Σ (value_i − mean)² ) / |mean|`, `∞` for `n < 2` or `mean = 0`.
- **Supporting trust** (node `State.runField`): `supportingTrust = ( Σ_{i: |value_i − m|/|m| ≤ 0.05} w_i ) / ( Σ_i w_i )` — the trust fraction whose reading is within 5% of the resonant value.

### Liveness attestation vs measured-value consensus

The protocol carries **two distinct kinds of observation** through the *same* Lock
machinery, and this is the crux of the PoR weakness:

- **Measured-VALUE consensus:** observers report a real measured quantity (e.g. an exchange rate, a benchmark). The median and CV gates make a flood of dishonest readings ineffective unless the attacker controls > 50% of domain weight.
- **Field-heartbeat LIVENESS attestation:** a mining/storage node periodically submits a *constant* observation `value = 1` on a fixed subject `FIELD_HEARTBEAT_SUBJECT` in domain `data`, carrying its self-reported `storageGiB` (`ZiraNode.contributeFieldHeartbeat`). Once `≥ MIN_OBSERVATIONS` such heartbeats converge, a Lock seals and the round emission is split among the heartbeaters (weighted by accuracy × storage bonus, §3). This is the "mining/storage earns from day one" path.

### Invariants

- **I-PoR-1 (no thin truth):** no Lock seals with fewer than 3 contributors, CV ≥ 2%, or support < 67%. Enforced both at seal time (`State.runField`) and at ingest (`validate.validateLock`).
- **I-PoR-2 (one Lock per subject per epoch):** `State.runField` skips a subject already locked at the current epoch.
- **I-PoR-3 (deterministic order):** subjects are processed in sorted order and observations deduped by `(timestamp, id)`, so emission and ZTI do not depend on gossip arrival order.

### WEAKNESS (must be stated plainly)

A *constant-value* heartbeat with *free identities* is **sybil-farmable**. Because every
honest and dishonest heartbeat reports the identical `value = 1`, the median/CV gates that
protect measured-value Locks provide **no protection** here: `N` keypairs the attacker
controls trivially converge (CV = 0), seal the Lock, and:

1. **farm the emission split** — they collectively draw the round reward, weighted by self-reported `storageGiB` (which is *not* verified — `storageGiB` is read straight off the observation in `State.runField`);
2. **manufacture trust** — each converging heartbeat lifts the observer's ZTI (§2), and enough trust lifts an identity into the master set, which **can capture finality** (§5).

Today the only friction is `BASE_FEE`-free observation submission and a per-address rate
limit (`docs/ZIRA_WHITEPAPER.md` §14). That is not a sybil cost.

### Hardening (formal target)

Let `chk` be the most recent **finalized** checkpoint root. Define an emission-eligibility
predicate that ties reward to *verifiable* contribution rather than mere presence:

```
EmissionEligible(p, epoch) ⟺
      AnsweredVerifiableQuery(p, epoch)        // a signed query receipt fused into a Lock
   ∨  PassedStorageChallenge(p, epoch)         // chunk-possession proof, below
```

- **Required-value binding.** A heartbeat's payload must commit to live finalized state, e.g. `value = H(chk ‖ p ‖ epoch) mod K`, so a valid heartbeat cannot be precomputed offline and is checkable against `chk`. This removes the "constant 1" degeneracy.
- **Verified-GiB via chunk-possession challenge.** Replace self-reported `storageGiB` with `VerifiedGiB(p) = Σ_m chunkSize(m) · [p answered a random chunk-possession challenge for model m this epoch]`. A challenge picks a random `(modelId, chunkIndex)` from the authorized catalog (content-addressed by sha256, `ModelStore.ts`) and requires `p` to return the chunk (or a Merkle proof of it) within a deadline. Only verified bytes earn the storage bonus.
- **Sybil cost via bond / PoW.** Gate identity participation in emission on a refundable **bond** (`bond_post`/`bond_return` already exist as tx kinds, `types.ts`) or a small **proof-of-work** stamp on the observation. Cost-per-identity `≫` per-identity emission removes the farming incentive.

### Current implementation

- `packages/protocol/src/por/field.ts` — `trustWeightedMedian`, `cv`, `convergeStep`, `tryLock`.
- `packages/protocol/src/ledger/validate.ts` — `validateLock` re-checks the four gates at ingest.
- `node/src/core/State.ts` — `runField` (seal + reward), uses self-reported `storageGiB`.
- `node/src/core/ZiraNode.ts` — `contributeFieldHeartbeat` (constant `value = 1`, self-reported `storageGiB`).

### Status

- Trust-weighted median, CV gate, MIN_OBSERVATIONS gate, support gate, one-Lock-per-epoch, deterministic order: **SHIPPED 1.5.x**.
- Required-value binding to finalized checkpoint; emission eligibility tied to answered-query/storage-challenge; verified-GiB via chunk-possession; bond/PoW sybil cost: **ROADMAP** (rationale: each changes the observation schema and/or the state-affecting reward path, so it belongs to the single planned protocol cut, not a hot-patch).

---

## 2. ZIRA Trust Index (ZTI)

### Definition

`ZTI(p, d) ∈ [0,1]` is identity `p`'s earned trust in domain `d`, recomposed after every
Lock `p` contributed to. It is also tracked overall. It gates: master eligibility, routing,
coordination payout weight, and anchor class standing.

### Formulas (`por/zti.ts`)

- **Accuracy of one reading:** `accScore = max(0, 1 − (2·error)²)`, `error = |value − m| / |m|`. A 10% miss ≈ 0.96; a 50% miss = 0.
- **Accuracy EMA:** `accuracy ← SMOOTHING·accScore + (1 − SMOOTHING)·accuracy`, `SMOOTHING = 0.08` — one bad reading barely moves a trusted identity; sustained bad readings grind it down.
- **Consistency:** `1 − CV` of the observer's own values in the window, clamped to `[0,1]`.
- **Uptime:** fraction of recent rounds taken part in; updated as `uptime ← min(1, 0.95·uptime + 0.05)` per participated round (`State.runField`).
- **Compose:** `ZTI = clamp01( 0.55·accuracy + 0.25·consistency + 0.20·uptime )` (`ACCURACY_WEIGHT/CONSISTENCY_WEIGHT/UPTIME_WEIGHT`).
- **Absence decay:** `ZTI ← ZTI · ABSENCE_DECAY^missedRounds`, `ABSENCE_DECAY = 0.9997` — ~a month away halves trust, keeping the master set current.

### Master threshold

`isMaster(p) ⟺ ZTI(p) ≥ MASTER_NODE_ZTI` (= 0.70). Set on the account in `State.runField`;
the authoritative master ZTI map is exported by `State.masterZtiMap()` for finality (§5).

### Invariants

- **I-ZTI-1 (earned, never bought):** ZTI updates only from Lock outcomes and uptime; no transaction credits ZTI. Funding a Resonator buys capacity, not standing (`docs/ZIRA_WHITEPAPER.md` §7, `resonators.ts`).
- **I-ZTI-2 (bounded value):** `ZTI ∈ [0,1]` always (clamp in `composeZti`).

### WEAKNESS

There is **no external ground truth** for `m`. On an attacker-chosen subject the attacker's
own keypairs form a self-quorum: they all report the same value, so `accScore ≈ 1` for each,
and every contributor's accuracy EMA climbs. Combined with the §1 heartbeat path, an attacker
can **lift trust toward 0.70 with no honest counterparty**. There is also **no bound on the
ascent rate** (other than SMOOTHING) and **no tenure or subject-diversity requirement** before
an identity becomes a master — so a well-funded sybil cluster can mint a master set quickly.

### Hardening (formal target)

- **Independent-support requirement.** Accuracy credit for a Lock counts only support from identities *not correlated* with `p` (e.g. distinct bonds, distinct ASNs/peer-ids as a heuristic, or anchor co-signers on sensitive domains). Formally, replace `accScore` credit with `accScore · 1[independentSupporters(lock) ≥ S_min]`.
- **Bounded per-epoch ascent + tenure.** Cap `ΔZTI ≤ ascentCap` per epoch and require `tenure(p) ≥ T_min` epochs of participation **and** contributions across `≥ D_min` distinct subjects/domains before `isMaster(p)` can be true: `MasterEligible(p) ⟺ ZTI(p) ≥ 0.70 ∧ tenure(p) ≥ T_min ∧ subjectDiversity(p) ≥ D_min`.
- **Slashing on contradicted Locks.** If `p` signed/supported a Lock later contradicted by a finalized Lock or by equivocation, apply a trust penalty (and, with bonds, a stake penalty): `ZTI(p) ← max(0, ZTI(p) − slash)`.

### Current implementation

- `packages/protocol/src/por/zti.ts` — all ZTI math.
- `node/src/core/State.ts` — `runField` applies EMA/consistency/uptime, sets `isMaster`; `masterZtiMap()`, `totalMasterTrust()`.

### Status

- Accuracy×consistency×uptime composition, EMA smoothing, absence decay, per-domain ZTI, master threshold: **SHIPPED 1.5.x**.
- Independent-support requirement, bounded ascent + tenure + subject-diversity gate, slashing on contradicted Locks: **ROADMAP** (rationale: bonds and a tenure/diversity ledger field are new consensus state; they ride the protocol cut with §1 and §5).

---

## 3. Emission and settlement correctness

### Definitions

- **MAX_SUPPLY:** `MAX_SUPPLY_UZIR = 28_700_000_000 · 1_000_000 = 2.87 × 10¹⁶ µZIR`.
- **Earned cap:** `EARNED_CAP_UZIR = round(MAX_SUPPLY_UZIR · 0.59) ≈ 1.6933 × 10¹⁶ µZIR`.
- **Issued:** `issued = RESERVE_UZIR + emitted` (`supply.ts`).
- **Circulating:** `circulating = issued − burned`.

### Emission formula

Per-round reward (`por/rewards.perRoundReward`):

```
remaining = EARNED_CAP_UZIR − emitted
taper     = floor( ROUND_EMISSION_FRACTION · remaining · max(0, demandMult) )   // fraction = 5e-7
reward    = min( max( MIN_ROUND_REWARD_UZIR, taper ), remaining )
```

`demandMult = demandMultiplier(activeSubjects)` flexes within `[0.5, 2.5]`, reference 6
subjects (`DEMAND_REWARD`). A per-epoch budget caps total emission to one demand-scaled curve
value so spawning many subjects cannot mint one reward *per* subject (`State.runField`, fix
"F4"). (Note: `constants.ts` also defines a formal `epochReward(n)` geometric-halving curve in
bigint; the live node currently emits via the `perRoundReward` taper. Reconciling the two onto
one curve is part of the bigint cut below.)

### Conservation invariant

> **I-EMIT-1 (conservation):** at every committed state,
> `Σ balances + burned == RESERVE_UZIR + emitted` and `emitted ≤ EARNED_CAP_UZIR` and `issued ≤ MAX_SUPPLY_UZIR`.

`auditSupply` (`supply.ts`) recomputes `balances`, `emitted`, `burned`, `reserveGranted`
purely from the signed tx log and reports `withinCap`. `SupplyTracker.canEmit/recordEmission`
reject any emission past the earned cap or any issuance past `MAX_SUPPLY_UZIR`. Fees are fully
burned (`FEE_BURN = 1.0`), so the sender pays `amount + fee` and the burned remainder is never
credited — making `circulating = issued − burned` exact without changing a balance.

### Reward-split soundness

> **I-EMIT-2 (split sums to whole):** `splitReward(total, …)` returns parts that sum to `total`
> exactly; rounding dust goes deterministically to the highest-weight contributor, ties by pubKey.

### WEAKNESS: float math at scale

`MAX_SUPPLY_UZIR ≈ 2.87 × 10¹⁶` **exceeds** `Number.MAX_SAFE_INTEGER ≈ 9.007 × 10¹⁵`.
Today `uZIR = number` (`types.ts`), and balances/emission/audit are done in
double-precision floats. Integers above `2⁵³` are not all representable, so arithmetic at the
largest balances is **not guaranteed exact**. Because every node computes identically, consensus
still holds *today*, but the state root is over float-derived values and exactness is not
provable at full scale — a latent determinism and audit risk.

### Hardening (formal target)

> **bigint migration.** Make `uZIR` an arbitrary-precision integer (bigint). All balances,
> emission, burn, reserve, and the split arithmetic operate on bigints; the **state root is
> computed over canonical decimal-string bigints** (stable, exact serialization). This makes
> `auditSupply` and `computeStateRoot` exact at full supply scale.

Rationale for deferral: it touches serialization, the state root, the genesis hash, and the
Console — so it is the **anchor of the single planned protocol cut**, done once with a
re-genesis and the full suite green, not a piecemeal change.

### Current implementation

- `packages/protocol/src/constants.ts` — `MAX_SUPPLY_UZIR`, `EMISSION`, `epochReward`, `STORAGE_REWARD`.
- `packages/protocol/src/por/rewards.ts` — `perRoundReward`, `demandMultiplier`, `splitReward`, `storageRewardMultiplier`.
- `packages/protocol/src/ledger/supply.ts` — `SupplyTracker`, `auditSupply`.
- `node/src/core/State.ts` — `runField` mints within the per-epoch budget and re-checks the cap before each credit.

### Status

- Conservation invariant + audit, reward-split soundness, earned-cap and max-supply enforcement, per-epoch emission cap (F4), full fee burn: **SHIPPED 1.5.x**.
- bigint migration (state root over decimal-string bigints) and curve reconciliation: **ROADMAP** (anchor of the protocol cut).

---

## 4. Coordination settlement

### Definition

When a funded query/task budget settles, it is a **pure division** of already-held ZIR among
the contributors that produced the answer, plus four fixed protocol slices — it **mints no
ZIR**. The split is a deterministic function (`por/rewards.settleCoordination`):

```
network        = floor(total · 0.08)
resonatorPool  = floor(total · 0.10)
ecosystem      = floor(total · 0.05)
burn           = floor(total · 0.05)
contributors   = total − network − resonatorPool − ecosystem − burn      // ≥ 0.72, absorbs all dust
```

Per-contributor weight `weight_i = max(0.01, ZTI(i, domain) · clamp(confidence_i, 0, 1))`;
contributor `i` receives `floor(contributors · weight_i / Σ weight)`, with dust to the highest
weight (ties by address). If no contributor answered, the contributors slice folds into the
network wallet so the sum stays exact.

### Invariants

- **I-COORD-1 (exact sum):** the five slices always sum to exactly `total` (`settleCoordination`, by construction).
- **I-COORD-2 (no minting):** settlement moves existing balance via real transfers and a `bond_burn` for the burn slice; supply `emitted` is untouched (`ZiraNode.settleQueryCoordination`).
- **I-COORD-3 (no self-serving split):** the split is computed identically by every node from the same inputs, so no node can pay itself more by computing it differently.

### WEAKNESS

Payout is by **self-reported confidence**, not by agreement with the realized outcome. A
provider can post `confidence = 1` and draw a large slice regardless of answer quality. There
is a partial guard — `settleQueryCoordination` drops contributors with `confidence ≤ 0` (fix
"F8") — but no calibration, no per-contributor cap, and no minimum number of *independent*
contributors. Today settlement is also **founder-gated at the RPC** (the funding wallet is the
node identity), not a permissionless consensus-triggered transaction.

### Hardening (formal target)

- **Agreement-with-outcome, not confidence.** Replace the weight with `weight_i = ZTI(i, domain) · agreement_i`, where `agreement_i` measures `i`'s answer against the fused/Locked outcome (e.g. inverse distance to the consensus answer). Add a **calibration penalty**: persistently over-confident, under-accurate providers lose effective weight over time.
- **Cap per-contributor share** at `shareCap` (e.g. ≤ 50% of the contributors slice) so a single provider cannot capture a budget.
- **Require ≥ 2 independent contributors** for any payout; otherwise refund or fold to the network slice.
- **Permissionless settle.** Make settlement a **consensus-triggered `settle` transaction**: any node may submit it once the answer set and challenge window close; validity (the split, the contributors, the agreement scores) is checked by every node, exactly like a transfer.

### Current implementation

- `packages/protocol/src/por/rewards.ts` — `settleCoordination` (pure split function), `COORD_SPLIT` shares.
- `node/src/core/ZiraNode.ts` — `settleQueryCoordination` (executes the transfers/burn; confidence > 0 filter, F8).

### Status

- Five-way split as a pure deterministic function, exact-sum invariant, no-minting, burn slice via `bond_burn`, confidence > 0 filter: **SHIPPED 1.5.x**.
- Agreement-based weight + calibration penalty, per-contributor cap, ≥ 2 independent contributors, permissionless consensus-triggered settle: **ROADMAP** (rationale: agreement scoring needs the fused-outcome record on-ledger and a challenge window in consensus state; deferred to the cut).

---

## 5. Finality and checkpoints

### Definitions

- **State root** `R(epoch)`: `sha3-256` over canonical, sorted account leaves (non-zero only), sorted anchor leaves, sorted founder set, and supply totals `{emitted, burned, reserve}` (`consensus.computeStateRoot`).
- **Checkpoint vote:** a master signs `CheckpointBody = {network, epoch, stateRoot, prevRoot, emitted, burned, reserve, timestamp}`; `prevRoot` links to the previous finalized root.
- **Finalization** (`consensus.tryFinalize`): group verified master votes by `stateRoot`; a root is **final** when its supporting trust reaches `FINALITY_THRESHOLD` (= 0.67):

```
support(root) = ( Σ_{v: voter(v) ∈ masterMap, stateRoot(v)=root} realZTI(voter(v)) )
                / totalActiveMasterTrust
final(root)  ⟺  support(root) ≥ 0.67
```

### Safety invariants

- **I-FIN-1 (no two final roots per epoch):** once a root finalizes for an epoch, no competing root replaces it; nodes do not reorganize below a finalized checkpoint (`docs/ARCHITECTURE.md`, whitepaper §5). Two roots cannot both clear 0.67 of the same honest-trust denominator without > 34% double-voting.
- **I-FIN-2 (authoritative master weight):** support is computed from `masterMap` (`State.masterZtiMap()`, real on-ledger ZTI keyed by voting pubkey), **never** from the vote's self-declared `voterZti`. A non-master that forges a high `voterZti` is silently dropped (`tryFinalize`, fix "F1").
- **I-FIN-3 (validity over trust):** a checkpoint can only finalize a state root every node can recompute; an invalid state cannot finalize regardless of how much trust signs it (each node validates independently).
- **I-FIN-4 (fast-sync soundness):** a snapshot is adopted only after it is verified to hash to a finalized root signed by genuine masters past two-thirds, and snapshot adoption is sequenced ahead of pulling the event tail (`docs/ARCHITECTURE.md`, `Checkpoints.ts`).

### WEAKNESS

A fresh PoR network has a genuine bootstrap problem: on day one no one has earned ZTI ≥ 0.70,
so finality leans on a **small seeded master set**. With one (or very few) masters, that single
operator's signature *is* finality — a concentration in tension with both the 0.67 ideal and
the operational rule that **steward keys never live on the VPS**. Multi-master finality requires
multiple keyed operators, which is exactly what "no steward key on the public host" makes
harder. There is also **no equivocation slashing**: a master that signs two different roots for
the same epoch is not penalized in code today.

### Hardening (formal target)

- **`M_min` distinct signers.** Require at least `M_min` *distinct* master identities behind any finalization, in addition to the 0.67 trust fraction: `final(root) ⟺ support(root) ≥ 0.67 ∧ |signers(root)| ≥ M_min`. Seed several masters at genesis rather than one.
- **Equivocation slashing.** If a master signs two distinct `stateRoot` for the same `(network, epoch)`, both votes are evidence; any node may submit a `slash` proof that removes the offender from the master set and (with bonds) burns its bond. Formally: `equivocation(p, epoch) ⟺ ∃ v1, v2 signed by p with epoch(v1)=epoch(v2) ∧ stateRoot(v1)≠stateRoot(v2)`.
- **Liveness fallback.** If no root reaches 0.67 within a bounded number of epochs (e.g. masters offline), define a deterministic fallback — extend the timestamp window and/or lower the live denominator to *active* masters only — so the chain does not stall while preserving I-FIN-1.
- **Key-handling reconciliation.** Run multiple keyed master operators on separate hosts (so no single VPS holds finality), keeping the genesis steward key offline. This makes decentralization of finality and "no steward key on the VPS" compatible by construction.

### Current implementation

- `packages/protocol/src/consensus.ts` — `computeStateRoot`, `verifyCheckpointVote`, `tryFinalize` (master-map gate, F1).
- `node/src/core/State.ts` — `masterZtiMap()`, `totalMasterTrust()`, `masters()`.
- `node/src/core/Checkpoints.ts` — vote receipt, finalization, fast-sync adoption.

### Status

- Deterministic state root, master-weighted finality at 0.67, authoritative master map (no forged `voterZti`), no-reorg-below-final, verified fast-sync adoption: **SHIPPED 1.5.x**.
- `M_min` distinct signers + multi-master seeding, equivocation slashing, explicit liveness fallback, multi-operator key handling: **ROADMAP** (rationale: distinct-signer count and slashing add consensus rules and new evidence tx kinds; multi-master seeding changes genesis — both ride the cut / fresh genesis).

---

## 6. Anchor economics and vesting

### Definitions

There are exactly **512** anchor seats across six classes (`ANCHOR_CLASSES`, `TOTAL_ANCHOR_SEATS`).
Each is a transferable structural position carrying a class ZTI standing, a routing weight, and a
reserve-backed ZIR allocation that vests over one year. Positions split half **reserved** (2× the
website figure) / half **open** (1×): 256 reserved (5.736B ZIR) + 256 open (2.868B ZIR) = **8.604B
ZIR**, within the 8.61B anchor reserve (~6M ZIR buffer; `ANCHOR_RESERVE_UZIR` is fixed to preserve
the genesis hash) (`constants.ts`, `anchors.ts`).

### Vesting formula (`reserve.ts`)

For a seat assigned at `startAt` with allocation `totalUZIR` over `ANCHOR_VESTING_DURATION_MS`
(= 365 days), linear vesting:

```
Vested(seat, t) = 0                                            if t ≤ startAt
                = floor( totalUZIR · (t − startAt) / duration ) if startAt < t < startAt + duration
                = totalUZIR                                     if t ≥ startAt + duration

Claimable(seat, t) = max(0, Vested(seat, t) − alreadyReleased(seat))
```

`floor` keeps releases conservative (never ahead of the true schedule) and integer-exact, so all
nodes agree on `Vested`.

### Invariants

- **I-ANCHOR-1 (reserve conservation):** every vesting release and reserve grant is a signed `reserve_grant` debiting the anchor-reserve wallet; `recordReserveGrant` rejects a grant exceeding the remaining reserve (`supply.ts`). Releases mint no ZIR — they move reserve-backed balance.
- **I-ANCHOR-2 (deterministic schedule):** `Vested(seat, t)` is a pure function of `(start, total, t)`; every node computes the same figure.
- **I-ANCHOR-3 (vesting follows the seat):** on transfer, class, weight, ZTI standing, and remaining vesting follow the new owner (`docs/ARCHITECTURE.md`, whitepaper §10).

### WEAKNESS

Today a release becomes real only when **a steward wallet signs** the `reserve_grant`
(`reserve.ts` header, `docs/ARCHITECTURE.md` "Reserve scheduling"). That puts the steward on the
**liveness path** for a beneficiary's vested funds: if the steward is offline, the beneficiary
cannot get vested ZIR even though the deterministic schedule says it is owed. This is both a
centralization and an availability concern, and it conflicts with keeping steward keys off the
live host.

### Hardening (formal target)

> **Claimable vesting from consensus state.** Make `Claimable(seat, t)` **claimable by the
> beneficiary** with a signed `anchor_vesting_claim` validated by every node: the ledger knows
> `startAt`, `totalUZIR`, and `alreadyReleased(seat)`, so it can authorize the exact claimable
> delta out of the anchor-reserve wallet **without a steward signature**. This removes the
> steward from the liveness path while preserving I-ANCHOR-1 (the reserve is still debited
> exactly, conservation intact).

Additionally, **rate-limit non-vesting reserve spend**: any reserve movement *not* on a vesting
schedule (grants, ops) is bounded per epoch so a compromised steward key cannot drain the reserve
in one block.

### Current implementation

- `packages/protocol/src/reserve.ts` — `anchorVestedToDate`, `anchorVestingClaimableUZIR`, distribution slots.
- `packages/protocol/src/constants.ts` / `anchors.ts` — allocations, class table, `ANCHOR_ACTIVATION_ENABLED = false`.
- `packages/protocol/src/ledger/supply.ts` — `recordReserveGrant` conservation check.

### Status

- Linear `Vested`/`Claimable` formula, reserve conservation, deterministic schedule, vesting-follows-seat, activation gate off: **SHIPPED 1.5.x**.
- Beneficiary-claimable vesting from consensus state (steward off the liveness path); rate-limited non-vesting reserve spend: **ROADMAP** (rationale: a new validated `anchor_vesting_claim` tx kind and a per-epoch reserve-spend limit are consensus rules; deferred to the cut).

---

## 7. Model authorization, replication, and domain routing

### Definitions

- **Authorized(model):** a model enters the field only when an active launch-authority key signs its canonical metadata. `Authorized(m) ⟺ ∃ k ∈ AuthoritySet : verify(canonical(meta_m), manifestSig, k)` (`ModelService.onAnnounce`). An announcement that is unsigned, signed by a non-authority key, or whose signature fails is rejected.
- **Content address:** a model id is the `sha256` of its bytes (`ModelStore.ts`, `models/types.ts`). Bytes stream and hash in 1 MB chunks; a fetched link whose content hash ≠ the authorized id is rejected (`ModelService` "the link's content does not match the authorized model hash").
- **Replication factor R:** `MODEL_REPLICATION_TARGET = max(1, ZIRA_MODEL_REPLICATION ?? 3)` — the target number of **live (connected) holders** per authorized model. Storage peers fetch under-replicated models first and stop once a model has R connected holders, so a large catalog spreads across many small peers rather than every peer cloning everything (`ModelService.ts`).
- **Domain routing:** `modelServesDomain(type, domains, domain)` decides eligibility; `preferredModelTypeForDomain(domain)` maps a query domain to a primary model type, text as universal fallback (`constants.ts`).

### Invariants

- **I-MODEL-1 (authorized-only):** no node accepts or serves a model not signed by the authority set; passing off altered weights under an authorized id is infeasible because the id *is* the content hash.
- **I-MODEL-2 (self-healing replication):** the field converges toward R live holders per model via storage peers filling gaps (`ModelService` storage reconcile).

### WEAKNESS

- **No revocation / expiry.** The authority signature has no expiry and there is no signed revocation: once authorized, a model is authorized forever, and a compromised or deprecated authority key cannot be cleanly retired. Authority is currently effectively a single signer (`isFounder`), not M-of-N.
- **Self-declared routing tags.** A model's serving domains are taken from its (authority-signed) metadata tags; eligibility to answer a domain is **declared**, not **measured**. Nothing yet conditions routing on demonstrated accuracy in that domain.
- **Load-time re-check.** Bytes are verified against the content hash on fetch/assembly; an explicit re-hash immediately before *every native load/serve* should be an enforced invariant, not only a fetch-time check.

### Hardening (formal target)

- **M-of-N authorization + revocation + expiry.** `Authorized(m) ⟺ ≥ M of N` authority keys signed `meta_m`, with `meta_m.expiresAt` and a signed `model_revoke` event: `Live(m, t) ⟺ Authorized(m) ∧ t < expiresAt ∧ ¬Revoked(m)`. Rotating or revoking a key is then a first-class, auditable operation.
- **Load-time hash re-check.** Enforce `sha256(assembledBytes) == m.id` immediately before any native load or endpoint serve; reject on mismatch.
- **Replication self-healing on live-holder count.** Drive replication off the *measured* live-holder count (already the basis of R) and re-fetch when a model drops below R due to churn.
- **Earned domain-routing eligibility.** Route a query to model/Resonator `x` for domain `d` only if `RoutingEligible(x, d) ⟺ probeAccuracy(x, d) ≥ θ`, where `probeAccuracy` is measured from periodic signed domain probes (held-out questions with known/consensus answers), not from self-declared tags.

### Current implementation

- `node/src/models/ModelService.ts` — `onAnnounce` (authority-signature gate), `MODEL_REPLICATION_TARGET`, content-hash check on fetch, storage reconcile.
- `node/src/models/ModelStore.ts` — content-addressed `sha256` storage, chunked hashing.
- `packages/protocol/src/constants.ts` — `modelServesDomain`, `preferredModelTypeForDomain`, `MODEL_TYPE_META`, `DOMAIN_META`.

### Status

- Authority-signed `Authorized(model)`, content-addressed ids, fetch-time hash check, replication factor R live-holders with self-healing, domain-aware coordination pickup, resource-aware native-vs-endpoint serving, inference in an isolated subprocess with timeout/abort and bounded concurrency: **SHIPPED 1.5.x**.
- M-of-N authorization + signed revocation + metadata expiry, enforced load-time re-hash invariant, earned (probe-measured) domain-routing eligibility: **ROADMAP** (rationale: M-of-N + revocation needs an authority set and revoke event in consensus/registry; probe-based routing needs a probe subsystem — both are additive, scheduled after the cut).

---

## 8. Free-tier → paid

### Definition

A fresh wallet may ask a bounded number of free questions per time window against the live field
(real queries, real Locks), subsidized through the network's first year, then closed; afterward
the ZIR tier (pay-per-use) and the Machine tier (own hardware) remain (`docs/ZIRA_WHITEPAPER.md`
§3/§11). The daily free allowance **tapers** over year one.

### Formula (target)

```
FreeQuota(identity, t) = baseQuota · taper(t)            // taper(t): 1 at launch → 0 at year 1 end
Allowed(identity, t)   = usedToday(identity) < FreeQuota(identity, t)
ContributorUnlimited(p) ⟺ VerifiedContribution(p) within the recent window   // §1 eligibility
SubsidyBudget(epoch)   = Σ_provider optInCapacity(provider, epoch)            // bounded by opt-in
```

### Invariants

- **I-FREE-1 (taper to close):** the free allowance is non-increasing over year one and reaches zero at the end; it is a launch subsidy, not a permanent fixture.
- **I-FREE-2 (subsidy bounded):** total free traffic served per epoch is bounded by providers' opted-in capacity, so the free tier cannot become a drain on the people whose machines run it.

### WEAKNESS

A quota keyed on **IP/address alone** is trivially sybil-bypassed (rotate wallets/IPs to refill
the allowance). "Contributor-unlimited" must be gated on **verified contribution**, not on a tag
a node can self-assert, or it becomes another free-emission farm (ties directly to §1).

### Hardening (formal target)

- **Identity-bound, sybil-resistant quota:** key `FreeQuota` to a bonded/PoW-stamped identity (§1), not to an IP, so refilling costs more than the quota is worth.
- **Contributor-unlimited gated on VERIFIED contribution:** `ContributorUnlimited(p)` requires `EmissionEligible(p)` (§1) — an answered verifiable query or a passed storage challenge — within the recent window.
- **Subsidy bounded by provider opt-in capacity:** providers advertise the capacity they will donate; free traffic is scheduled within that budget and throttled under load.

### Current implementation

- Console tiers and the timed free subsidy are product-layer (`apps/console`, `docs/ZIRA_WHITEPAPER.md` §11); the field path is the same query/answer machinery as paid traffic (`ZiraNode` query/answer, relay escrow `SPECIAL_ADDRESSES.RELAY_ESCROW`).
- Resource sharing / opt-in capacity is operator-controlled via the Mine resource slider (product layer).

### Status

- Real free queries against the live field, per-window rate limiting, the conceptual first-year taper and close, ZIR + Machine tiers: **SHIPPED 1.5.x** (product layer; taper schedule is operational policy).
- Sybil-resistant identity-bound quota, contributor-unlimited gated on verified contribution, subsidy formally bounded by provider opt-in capacity: **ROADMAP** (rationale: depends on §1 bonded/PoW identity and verified-contribution eligibility).

---

## 9. Shipped vs Roadmap — summary

| # | Area | SHIPPED 1.5.x | ROADMAP (deferred) |
|---|------|---------------|--------------------|
| 1 | PoR | median/CV/MIN_OBS/support gates, deterministic seal & reward | checkpoint-bound heartbeat value, emission eligibility (answered query / storage challenge), verified-GiB chunk-possession, bond/PoW identity |
| 2 | ZTI | acc×cons×uptime + EMA + decay, per-domain, master threshold | independent-support, ascent caps + tenure + diversity, slashing on contradicted Locks |
| 3 | Emission | conservation + audit, split soundness, cap enforcement, per-epoch cap, full burn | bigint migration (state root over decimal-string bigints), curve reconciliation |
| 4 | Coordination | pure 5-way split, exact-sum, no-minting, confidence>0 filter | agreement-based payout + calibration, per-contributor cap, ≥2 independent, permissionless consensus settle |
| 5 | Finality | deterministic root, 0.67 master finality, authoritative master map, no-reorg, verified fast-sync | M_min distinct signers + multi-master seeding, equivocation slashing, liveness fallback, multi-operator keys |
| 6 | Anchors | linear vesting formula, reserve conservation, deterministic schedule, activation gate off | claimable vesting from consensus state, rate-limited non-vesting reserve spend |
| 7 | Models | authorized-only, content-addressed, fetch-time hash check, R live-holders self-heal, domain pickup, resource-aware serving, isolated inference + timeout/abort + bounded concurrency | M-of-N + revocation + expiry, enforced load-time re-hash, probe-measured domain-routing eligibility |
| 8 | Free→paid | real free queries, rate limiting, taper-to-close, ZIR/Machine tiers | sybil-resistant identity-bound quota, contributor-unlimited on verified contribution, opt-in-bounded subsidy |

**Why the roadmap items are grouped, not hot-patched.** Most deferred items change how state is
computed (bigint, eligibility predicates, new tx kinds, multi-master seeding, claimable vesting) or
the observation/checkpoint schema. A clean public mainnet deserves a **single planned protocol cut**
— anchored by the bigint migration — with a re-genesis and the full suite green, rather than repeated
forks. Additive, non-state items (probe routing, model revocation tooling, the free-tier subsidy
schedule) can ship continuously.

---

## 10. Launch invariants — checklist for the fresh public mainnet

These are the properties that **must hold** for the fresh public mainnet. Each is marked as
**enforced by code today** or **operational** (held by process/policy until the corresponding
roadmap item lands).

### Enforced by code today

- **[code] Conservation.** `Σ balances + burned == RESERVE_UZIR + emitted`, `emitted ≤ EARNED_CAP_UZIR`, `issued ≤ MAX_SUPPLY_UZIR` — `supply.auditSupply`, `SupplyTracker.recordEmission`. *(Exactness at the largest scale is bounded by float until the bigint cut; values are within `2⁵³` for the foreseeable circulating range, and every node computes identically.)*
- **[code] Emission curve cap.** Per-round reward is curve-bounded and clamped to remaining; total per-epoch emission is capped to one demand-scaled curve value (F4) — `por/rewards.perRoundReward`, `State.runField`.
- **[code] Reward-split soundness.** Reward and coordination splits sum to the whole, deterministic dust — `splitReward`, `settleCoordination`.
- **[code] No double-finalize.** No two roots finalize for one epoch; no reorg below a finalized checkpoint; finality weighted by authoritative on-ledger master ZTI, never self-declared `voterZti` — `consensus.tryFinalize` (F1), `Checkpoints.ts`.
- **[code] Validity over trust.** Every node validates events under full rules; an invalid state cannot finalize — `ledger/validate.ts`, `consensus.ts`.
- **[code] Authorized-models-only.** Only authority-signed, content-addressed models enter the field; content-hash mismatch is rejected — `ModelService.onAnnounce`, `ModelStore`.
- **[code] Replay/reorder resistance.** Strict per-account nonce sequencing; duplicate event ids rejected — `validate.validateTx`.
- **[code] Reserve conservation & authority.** `reserve_grant` only from an active founder; grant cannot exceed remaining reserve — `validate.validateTx`, `supply.recordReserveGrant`.
- **[code] PoR seal gates.** No Lock without ≥3 observers, CV < 2%, support ≥ 67% — `field.tryLock`, `validate.validateLock`, `State.runField`.
- **[code] Anchor activation off at launch.** `ANCHOR_ACTIVATION_ENABLED = false` — no routing revenue until the gate opens.
- **[code] Isolated inference.** Native generation runs in a separate process with timeout/abort and bounded concurrency, so it cannot stall consensus/peering.

### Operational (held by process until the matching roadmap item lands)

- **[operational] Sybil resistance of the heartbeat path.** Until checkpoint-bound heartbeat value + bond/PoW identity ship (§1), the constant-value heartbeat is sybil-farmable; mitigated only by a small, trusted launch operator base and address rate-limiting.
- **[operational] Master-set integrity.** Until M_min distinct signers + equivocation slashing ship (§5), finality concentration and equivocation are bounded by running few, trusted, separately-keyed masters (and keeping the genesis steward key offline).
- **[operational] Free-tier taper.** Until identity-bound quota + opt-in-bounded subsidy ship (§8), the first-year taper-to-close is policy enforced at the product/console layer, not in consensus.
- **[operational] Anchor vesting liveness.** Until claimable vesting ships (§6), vested releases depend on the steward signing `reserve_grant`; the schedule itself is deterministic and auditable.
- **[operational] Exact accounting at full scale.** Until the bigint migration ships (§3), exactness above `Number.MAX_SAFE_INTEGER` rests on identical float computation across nodes, not on integer-exact arithmetic.
- **[operational] Model lifecycle.** Until M-of-N + revocation + expiry ship (§7), authority is effectively a single signer with no revocation; mitigated by careful key custody.

---

*License: MIT. This document formalizes intended and live behavior of the ZIRA protocol. Items
marked ROADMAP are intention, not a promise. Nothing here is investment advice or a solicitation.*
