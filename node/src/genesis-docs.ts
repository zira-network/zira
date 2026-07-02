// node/src/genesis-docs.ts
// The built in genesis documents. Every node on a network must agree on the exact doc, the way
// bitcoin nodes agree on the genesis block. The primary genesis steward receives the launch reserve.
// Do not change mainnet addresses after launch, or nodes will be on different networks.
import { standardGenesis, PROTOCOL, addressFromPubKey, hashHex, type Address, type GenesisDoc, type NetworkId } from "@zira/protocol";

// Fixed timestamps so the genesis hash is stable. Do not change after launch.
// Mainnet uses a RECENT genesis timestamp (2026-07-02) so there is no multi-million-epoch grace
// fast-forward at launch: with the old 2023 constant every node skipped ~16.6M empty 5s epochs to reach
// real time, and the skip landing point depended on each node's local observation pool, which diverged
// emission across masters and stalled quorum finality. A near-now genesis keeps the catch-up to a handful
// of epochs that every node processes identically. devnet/testnet keep the old constants (single-node/test).
const TS = { devnet: 1_700_000_000_000, testnet: 1_700_000_001_000, mainnet: 1_783_000_000_000 };

// The mainnet genesis reserve (41% of the cap) is seeded on-ledger at block 0, fully auditable, never
// a post launch transfer. It is not a founder premine: most of it is reserved for anchor owners.
//   - 30% anchor reserve, in MAINNET_ANCHOR_RESERVE, a labeled wallet the founder administers (not
//     founder funds): released to anchor seat owners as they redeem their anchor codes, optionally
//     vested over a period. ZIR leaves it only to seat owners.
//   - 10% community events and airdrop reserve, in MAINNET_EVENTS_WALLET, claimed or granted, never sold.
//   - 1% founder operations, in the primary steward wallet, for gas, bootstrap, and ecosystem grants.
// The 59% earned share is emitted only as rewards. These addresses are public; their private keys are
// local founder operator material only. Do not change after launch, or nodes will be on a different network.
// Fresh genesis wallets generated for the public launch (2026-06-28). All are steward-administered; the
// private keys live only in the private folder (z/private + local-private), never on the VPS.
const MAINNET_ANCHOR_RESERVE = "zir1zms84nsnv6svzycpmqa5fperfzwmgmn4xkqu6u";
const MAINNET_EVENTS_WALLET = "zir1h8wrtuwsmvynsz3z45d7g64ljsqqwktsm0rt0l";
// §9 coordination settlement wallets (steward-administered, like the reserves; keys in the private folder).
// They start at zero and accumulate from settlements. The network wallet funds protocol sustainability; the
// resonator pool is distributed to active anchor holders by lattice weight. The ecosystem slice routes to
// the events wallet.
const MAINNET_NETWORK_WALLET = "zir1mhq2jjsh8j93ye9dkh03g7udttrjpsqj3zl2u4";
const MAINNET_RESONATOR_POOL = "zir1f65yv3665xhzj5s06zy3k8ca23jd29kunaemg9";
const ANCHOR_RESERVE_UZIR = PROTOCOL.ANCHOR_RESERVE_UZIR;                                                               // 8.61B ZIR
const EVENTS_RESERVE_UZIR = Math.round(PROTOCOL.MAX_SUPPLY_ZIR * PROTOCOL.EVENTS_RESERVE_SHARE) * PROTOCOL.UZIR_PER_ZIR; // 2.87B ZIR
const FOUNDER_OPS_UZIR = Math.round(PROTOCOL.MAX_SUPPLY_ZIR * PROTOCOL.FOUNDER_OPS_SHARE) * PROTOCOL.UZIR_PER_ZIR;       // 287M ZIR

// The primary stewardship address for each network. The devnet one is the well known devnet test
// key's address, so a local devnet works out of the box.
const FOUNDER = {
  // address of private key 0x01 repeated, the devnet test steward (NEVER use for real funds)
  devnet: "zir1jh7l9csu7ae92k5kl2dsl7cdqhkuceytpjy69g",
  testnet: "zir1jh7l9csu7ae92k5kl2dsl7cdqhkuceytpjy69g",
  // The primary genesis steward that receives the launch reserve. Fresh wallet for the public launch;
  // private key in the private folder only. Do not change after launch.
  mainnet: "zir1km32wyjkya4h6utahkuckm56zgshnevy4v3a7t",
};

// The active founder set: the steward plus two steward-held backups, all fresh for the public launch.
const MAINNET_FOUNDERS = [
  "zir1km32wyjkya4h6utahkuckm56zgshnevy4v3a7t",
  "zir1c7q2fzk6lmaxsnx4s7twftzlpcd749xa6v0r7z",
  "zir1czsjyrjf8wts662kd7s9um4nmyaapjhcvr0x7n",
];

// The bootstrap finality quorum: four keyless coordinator nodes (the operator's VPS) that co-sign Proof
// of Resonance checkpoints with their OWN node-identity keys — never the founder key, which stays local
// and off the VPS. Seeded at full trust; any three of four finalize (3/4 = 0.75 >= the 0.67 threshold),
// so finality continues even with one node down and never depends on the local steward being online. The
// founder is deliberately NOT in this set, so its absence cannot stall finality. As real miners earn
// master standing over time (sybil-resistant admission), the quorum decentralizes beyond these four.
// Public address + pubkey only; the matching private node-identity keys live in local-private/master-keys
// and are deployed to each coordinator's data dir as identity.json. Do not change after launch.
const MAINNET_MASTERS = [
  { address: "zir1uxdygk07yfz6uknd7avd8e3muyfjyacqw7cr67", pubKey: "0cd84922cdb7d1924a7f2d1ebe35df3a3da18cc6a2d1610356371f82d065d5b6" },
  { address: "zir1c3uad6vsd6maazshqkxdhla3dcf45704tsgn0m", pubKey: "4fceadc8c21c88f78bf9f0599ee7da87d7cda58a74f7c22a40c074766ed44425" },
  { address: "zir1f2kjpnea8knu960mrw4us3rsww7yrft26sx240", pubKey: "2a16340afa6315a62bceb2bb42e9070601665c512fe306f47b2f87dd309b1b06" },
  { address: "zir1pfyvmtg28ctr3zrznx0uqwj7gvm6mdd9809k3e", pubKey: "14420c2d8dac7b974f830cc8514951491381123fc26378926e362ac128346e11" },
];

export function genesisFor(network: NetworkId, founderOverride?: string): GenesisDoc {
  const founder = founderOverride ?? FOUNDER[network];
  const doc = standardGenesis(network, founder, TS[network],
    network === "mainnet"
      ? "ZIRA mainnet genesis. Trust is earned, never bought. Use is security."
      : `ZIRA ${network} genesis. Test ZIR has no value.`);
  if (network === "mainnet" && !founderOverride) {
    // Seed the 41% reserve: 30% anchor reserve + 10% community events + 1% founder operations.
    // These sum to PROTOCOL.RESERVE_UZIR, so supply accounting (issued = reserve + emitted) stays exact.
    // The anchor reserve is administered by the founder and released only to anchor seat owners.
    const allocations = [
      { address: MAINNET_ANCHOR_RESERVE, amountUZIR: ANCHOR_RESERVE_UZIR, note: "anchor reserve, 30 percent, released to seat owners as they redeem anchor codes" },
      { address: MAINNET_EVENTS_WALLET, amountUZIR: EVENTS_RESERVE_UZIR, note: "community events and airdrop reserve, 10 percent of supply" },
      { address: founder, amountUZIR: FOUNDER_OPS_UZIR, note: "founder operations, 1 percent, for gas, bootstrap, and grants" },
    ];
    return { ...doc, founders: MAINNET_FOUNDERS, masters: MAINNET_MASTERS, allocations };
  }
  return doc;
}

/**
 * The §9 coordination settlement targets for a network. On mainnet these are the real
 * steward-administered keyed wallets above (network wallet, resonator pool) plus the events wallet for
 * the ecosystem slice. On devnet/testnet they are deterministic addresses (no real funds) so settlement
 * routing works in tests without managing keys. These wallets are not genesis-seeded, so returning them
 * here never affects the genesis hash.
 */
const settlementSink = (label: string): Address => addressFromPubKey(hashHex(`zira:settlement:${label}`));
export function settlementWalletsFor(network: NetworkId): { network: Address; resonatorPool: Address; ecosystem: Address } {
  if (network === "mainnet") {
    return { network: MAINNET_NETWORK_WALLET, resonatorPool: MAINNET_RESONATOR_POOL, ecosystem: MAINNET_EVENTS_WALLET };
  }
  return {
    network: settlementSink(`${network}:network`),
    resonatorPool: settlementSink(`${network}:resonator-pool`),
    ecosystem: settlementSink(`${network}:ecosystem`),
  };
}

/**
 * The labeled project wallets the steward administers, for the Treasury view. All are public on-ledger
 * ZIR addresses (the private keys are local operator material only, never in source). Returning them here
 * affects no consensus state. On mainnet these are the real reserve/settlement wallets; on test networks
 * they are the deterministic settlement sinks so the view works without managing keys.
 */
export interface TreasuryWallet { key: string; label: string; address: Address; role: string }
export function treasuryWalletsFor(network: NetworkId): TreasuryWallet[] {
  const s = settlementWalletsFor(network);
  const steward = FOUNDER[network];
  if (network === "mainnet") {
    return [
      { key: "steward", label: "Genesis steward · operations", address: steward, role: "Founder operations (1% of supply): gas, bootstrap, ecosystem grants." },
      { key: "anchorReserve", label: "Anchor reserve", address: MAINNET_ANCHOR_RESERVE, role: "30% reserve, vested to anchor seat owners as positions are assigned." },
      { key: "events", label: "Events & airdrop reserve", address: MAINNET_EVENTS_WALLET, role: "10% community events and airdrops; also receives the ecosystem settlement slice." },
      { key: "network", label: "Network wallet", address: s.network, role: "Coordination settlement: long-term protocol sustainability." },
      { key: "resonatorPool", label: "Resonator pool", address: s.resonatorPool, role: "Coordination settlement: distributed to active anchor holders by lattice weight." },
    ];
  }
  return [
    { key: "steward", label: "Steward · operations", address: steward, role: "Stewardship and operations (test network)." },
    { key: "network", label: "Network wallet", address: s.network, role: "Coordination settlement sink (test network)." },
    { key: "resonatorPool", label: "Resonator pool", address: s.resonatorPool, role: "Resonator-pool settlement sink (test network)." },
    { key: "ecosystem", label: "Ecosystem", address: s.ecosystem, role: "Ecosystem settlement sink (test network)." },
  ];
}

// The well known devnet steward private key, so the local testnet can sign stewardship grants and
// seed observations. NEVER use on testnet or mainnet.
export const DEVNET_STEWARD_PRIVATE_KEY = "01".repeat(32);

