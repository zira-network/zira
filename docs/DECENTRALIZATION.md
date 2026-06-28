# Decentralization, honestly

ZIRA is peer to peer from the first line. There is no company, no coordinator, and no server in the
middle. The ledger lives on nodes anyone can run, every node validates every rule, and consensus is
Proof of Resonance, not the say so of any operator. This document is honest about the one part that
is concentrated at the start and how it spreads.

## What is decentralized now

- **Ownership.** Every wallet is a keypair held by the user. Every transaction is signed by the
  sender and verifiable by anyone. No node can forge a balance.
- **The ledger.** It is gossiped between nodes and rebuilt independently by each one from signed
  events. There is no single copy to seize or shut off.
- **Validation.** Every node enforces the supply cap, the fee burn, nonces, and signatures. An
  invalid event is rejected by honest nodes no matter who sent it.
- **Intelligence.** The AI runs on participants' own machines. Answers are signed and coordinated by
  earned trust. No company holds an off switch.

## The honest concentration: bootstrap finality

A brand new Proof of Resonance network has a chicken and egg problem: finality comes from master
nodes (ZTI ≥ 0.70), but trust is only earned over time by serving the field accurately. On day one,
no one has earned it yet.

So the genesis steward starts as a **bootstrap master**: a single high trust node that signs
checkpoints so the network has finality from the start. This is the genesis concentration, stated
plainly, the same honesty the whitepaper applies to the genesis pre-allocation. It is a referee that
cannot forge (every checkpoint is over a state every node can recompute and verify), not an owner.

To be clear, this concentration is about checkpoint signing, not about holding tokens. The 1
percent founder operations slice (287,000,000 ZIR) is the only ZIR the founder spends freely. The 30
percent anchor reserve (8,610,000,000 ZIR) sits in a founder-administered anchor-reserve wallet,
`zira-anchor-reserve`, held on behalf of the seat owners, not as founder funds: it is released to
the 512 anchor seat owners as they redeem their anchor codes, and every release is a signed public
ledger entry. Trust is earned, never bought.

## How it decentralizes

1. **More operators run nodes.** Each validates independently, so trusting the steward is optional:
   run your own node and verify the chain yourself.
2. **Operators earn ZTI** by submitting accurate observations and serving the field. As they cross
   0.70 they become master nodes and start signing checkpoints.
3. **Finality spreads.** The finality denominator is the total active master trust. As real masters
   accrue, the steward's share shrinks and finality no longer depends on it. The threshold (0.67 of
   master trust) means no single node can finalize alone once trust is spread.
4. **The steward steps back.** Once enough independent master trust exists, the steward is just one
   master among many, and can stop signing without halting the network.

No dates are promised. This needs real operators, which needs the network to be worth running. The
code makes that possible and verifiable. It does not manufacture the community.

## What this is not

It is not a claim of instant trustlessness, and it is not a token sale. ZIR has no value until a real
network exists, and maybe not then. Devnet and demo ZIR have no value. Early finality leans on the
steward. Total loss is possible. The right posture is to run a node, read the rules in
`packages/protocol`, and verify rather than trust.
