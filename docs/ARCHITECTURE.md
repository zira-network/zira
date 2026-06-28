# ZIRA architecture

ZIRA is a peer to peer network. There is no central server. This document describes how the parts
fit and how nodes agree without a referee.

## Components

- **packages/protocol** is the single source of truth for everything consensus critical: crypto,
  the canonical encoding (the exact bytes that get signed), the Proof of Resonance math, the ledger
  rules, the genesis document, the state root, and checkpoint verification. The node and the Console
  both depend on it, so they cannot drift.
- **node (ZIRA Core)** is a daemon anyone runs. It is a libp2p peer and a deterministic state
  machine. It serves the Console and an RPC.
- **apps/console** is a static GUI. It holds keys in the browser, signs locally, and reads and
  writes through a node. It never holds anything the node needs to trust.

## The peer to peer layer (libp2p)

- **Transports:** TCP and WebSockets. Encryption with Noise, multiplexing with yamux.
- **Propagation:** gossipsub. Events are published on a few topics namespaced by the genesis id, so
  nodes on different genesis documents never cross talk.
- **Discovery:** bootstrap peers. A node dials the peers in `ZIRA_BOOTSTRAP` and learns the rest.
- **Sync:** when a node connects to a peer it opens a length prefixed stream and pulls the peer's
  durable event log, so a fresh or returning node rebuilds state. Nodes also periodically re-gossip
  their pending pool, so a peer that missed a message (or joined late) still converges.
- **Identity:** each node persists a stable libp2p peer key, so bootstrap nodes keep their id.

## The deterministic ledger (the Living Web)

Every transaction and observation is a signed event held in a pool. State advances in fixed epochs
(`ACCOUNTING_ROUND_MS`). When an epoch closes (after a short grace for gossip to settle), the node
processes that epoch's events in a canonical order:

1. **Transactions** are applied sorted by sender, then nonce, then id. A transaction is rejected
   unless its signature verifies, its address derives from its public key, its nonce is the sender's
   next nonce, and the sender can cover the amount plus the fee. A double spend at the same nonce is
   resolved deterministically (the lower id wins), so every honest node makes the same choice.
2. **Observations** in the trailing window feed Proof of Resonance per subject: the trust weighted
   median (never the mean), the coefficient of variation, and the supporting trust. When the gate is
   met a **Lock** seals, contributor **ZTI** updates from accuracy, consistency, and uptime, and a
   tapering **reward** is minted and split by accuracy, never exceeding the earned cap.

Anchor ownership transactions are applied in the same deterministic pass. A claim proves a private
seat code against the public genesis hash, then future movement is transfer-only. Listing and delisting
are ledger-visible, while activation is rejected until the future activation gate opens.

Because all nodes process the same events the same way, they derive the same committed state.

## Proof of Resonance finality

Finality replaces Proof of Work with earned trust:

- Each node computes a deterministic **state root**: a sha3-256 over the sorted account balances,
  nonces, active stewardship addresses, anchor seats, and the supply totals.
- **Master nodes** (ZTI ≥ 0.70) sign a **checkpoint** over the root each epoch and gossip the vote.
- A checkpoint that gathers ≥ `FINALITY_THRESHOLD` (0.67) of the active master trust is **final**.
  Nodes will not reorganize below a finalized checkpoint.

Because every node enforces the rules, a checkpoint can never finalize an invalid state. Trust is
earned by useful work (accurate observations, served intelligence), so the network gets harder to
attack the more it is used honestly. This is "use is security", made concrete.

## Genesis

A genesis document fixes the network: its network id, timestamp, initial stewardship addresses, the
41 percent genesis pre-allocation, the public anchor seat code hashes, seeded anchor ownership, and a
message. Its sha3 hash is the network identity. Nodes on different genesis documents are on different
networks.

The total supply cap is 28,700,000,000 ZIR (28.7B). The 41 percent genesis pre-allocation
(11,767,000,000 ZIR, 11.767B) is transparent and confirmed on-ledger from block 0 as genesis
allocations, never a post-launch transfer. It splits into three parts:

- **Anchor reserve: 30 percent (8,610,000,000 ZIR, 8.61B).** Held in a founder-administered
  anchor-reserve wallet `zira-anchor-reserve` on behalf of the seat owners, not as founder funds. It
  is released to the 512 anchor seat owners as they redeem their anchor codes, optionally on a vesting
  schedule, and every release is a signed public ledger entry. It is held separate from founder operations.
- **Ecosystem & events reserve: 10 percent (2,870,000,000 ZIR, 2.87B).** Held in the public events
  wallet (address `zir1rnhfhxk3h9v0u5sljfyr823eyq6hhufm96jd0f`). It funds community airdrops and
  ecosystem events. It is earned-only and claimed transparently; it is never a purchase, never sold,
  no USDT, no OTC. The "+" claim only appears when the founder has events active and the reserve is
  funded.
- **Founder operations: 1 percent (287,000,000 ZIR, 287M).** Held in the primary steward wallet,
  used only for gas, bootstrapping nodes, and ecosystem grants. This 1 percent is the only ZIR the
  founder spends freely. The anchor and events reserves are held for their owners, not as founder funds.

The other 59 percent of supply (16,933,000,000 ZIR, 16.933B) is unissued and brought into existence
only as earned rewards for real work (mining, coordination, inference) over time, on a geometric
halving emission curve. Half of every transaction fee is burned forever. Trust is earned, never
bought: the 1 percent operational slice is the only ZIR the founder spends freely, and the anchor
reserve is held for the seat owners who redeem it.

## Anchor seats

ZIRA has 512 ZRC-1 anchor seats across six topology classes: Genesis, Meridian, Nexus, Lattice,
Sentinel, and Foundation. A seat is a structural position, not automatic income or special voting
power. Owners can claim, hold, transfer, and list seats now. Activation is disabled until all seats are
secured; after activation, routing revenue depends on the operated work, ZTI, uptime, and field bonds.
Class topology weights descend from Genesis 6/6, Meridian 5/6, Nexus 4/6, Lattice 3/6, Sentinel 2/6,
to Foundation 1/6.

## The Console and the relay

The Console asks the field by publishing a query on the relay topic. Providers (nodes or browsers
running their own local models) answer, sign, and gossip their answers. The asker ranks signed
answers by domain ZTI, shows a verifiable receipt, and tips the contributors with real signed
transactions. The model never runs on anyone else's machine, and no company holds an off switch.

Local workspace mode is still field coordinated, not local-model mining. The user explicitly chooses a
folder, grants browser write permission, and attaches only the files they want to send as content. ZIRA
routes the task through the field, then writes a local `.zira/tasks/...` task package back into the chosen
folder so the work exists on the user's machine instead of remaining as instructions in chat.

## The model field

The intelligence is a curated, peer to peer field of models and capability domains, decoupled from the
miners that run them.

- **Only active launch authority adds models.** An authorized steward can add a raw GGUF URL, or a
  local GGUF path when the node runs on the same machine and can read it. The node fetches or reads it
  once, content addresses it by sha256, and signs the entry. Every node rejects a model that is not
  signed by active launch authority, so the field stays curated even though it is fully peer to peer.
- **Distribution is a hybrid swarm.** A node that needs a model gets it from a peer that already has
  it; if none do, it falls back to the original signed source link, verifies the hash, and then serves it to
  others too. Every node starts as a small storage peer with a 1GB cap, and users can disable storage or
  raise the cap. Storage peers actively pull under-replicated authorized models first, so the swarm
  carries the load instead of waiting passively. There is no single host.
- **Mining is model agnostic.** A miner can lend workspace task permission, coordination,
  observations, a native GGUF engine, or an OpenAI-compatible endpoint. Model byte distribution is a
  storage-peer role, not a requirement for mining. In auto mode the node runs the field-recommended
  model for the miner's capabilities when that path is enabled. ZIRA coordinates answers from the
  field with trust weighting and receipts.
- **Storage starts small and opt-out.** New nodes default to P2P storage enabled with a 1GB local cap.
  Users can raise, lower, or disable the cap from the Mine page. This makes ZIRA a distributed neural
  economy: many small peers hold verified pieces of the model field, while larger peers can voluntarily
  become backbone storage hosts.
- **Built for change.** Catalog entries carry capability tags (domains) and a version. The current
  launch path accepts GGUF models, while the taxonomy is already ready for image, video, audio, tool,
  and multimodal model families without changing consensus rules.

## Reserve scheduling

The 30 percent anchor reserve lives in the founder-administered `zira-anchor-reserve` wallet and is
released to anchor seat owners as they redeem their anchor codes, each release a signed public
`reserve_grant` so the distribution stays auditable. The other steward allocations (the 1 percent
founder operations slice and the ecosystem & events reserve) flow through the same signed transactions. Immediate `reserve_grant` transactions are
ledger-visible. The Console also includes a local stewardship scheduler that splits an
allocation across a start date, period, cadence, and one or more target addresses. Due installments are
submitted as normal signed `reserve_grant` transactions while the steward wallet is open and unlocked;
future installments can be cancelled locally, but already-signed grants remain public ledger history.
Active stewards can delegate another steward with `founder_delegate` and remove a delegated steward
with `founder_revoke`; the genesis steward remains permanent.

## Scaling: fast sync and empty epoch skipping

Two things keep the network scalable as history grows:

- **Fast sync.** A brand new node does not replay the whole chain. On joining it adopts a finalized
  state snapshot from a peer over `/zira/snapshot/1.0.0`, then validates every event after it. This
  is weak subjectivity: you trust the snapshot you bootstrap from, exactly like modern proof of stake
  chains. Run with `ZIRA_FULL_SYNC=1` to skip this and verify from genesis instead.
- **Empty epoch skipping.** Epochs with no events are advanced in O(1) rather than iterated, so a
  node started long after genesis (or restarted) catches up instantly instead of looping over every
  past round.

The event log a node serves to peers for the recent gap is capped, so joining stays cheap no matter
how long the history is.

## Storage

Each node keeps an append only event log and periodic state snapshots, with no native dependency, so
it runs anywhere Node runs. On start it loads the snapshot and replays newer events.

Model storage is content addressed. Authorized GGUF bytes are split into verified chunks and replicated
by storage-enabled peers under each peer's local cap. A default 1GB peer may not hold a full large model,
but it still participates in the decentralized swarm and can carry smaller artifacts. Larger storage
operators can raise the cap to replicate full models and improve field continuity.

## Tasks and Resonator coordination

Discover and workspace tasks are not limited to one model answering alone. A task can be handled by
multiple factors: the hired Resonator, other Resonators it coordinates with, model-backed miners,
storage evidence, user budgets, minimum-ZTI constraints, and final settlement checks. Owners allocate
ZIR to Resonators so they can pay for deeper coordination and collaboration. ZIR funding increases
capacity; ZTI is still earned from verified outcomes only.
