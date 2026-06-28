// packages/protocol/src/genesis.ts
//
// The genesis document is the deterministic starting point every ZIRA Core node agrees on,
// the way bitcoin's genesis block is hard coded. Its hash is the network's identity: nodes on
// different genesis docs are on different networks and will not sync.
import { PROTOCOL, type NetworkId } from "./constants";
import { hashHex } from "./crypto";
import { canonical } from "./serialize";
import { DEFAULT_ANCHOR_CODE_COMMITMENTS, DEFAULT_MAINNET_ANCHOR_OWNERSHIP } from "./anchors";
import type { Address, AnchorCodeCommitment, AnchorGenesisOwnership, Hex, PublicKey, uZIR } from "./types";

export interface GenesisAllocation {
  address: Address;
  amountUZIR: uZIR;
  note?: string;
}

/**
 * A genesis master: a keyless coordinator node designated at genesis as part of the bootstrap finality
 * quorum. It co-signs Proof of Resonance checkpoints with its OWN node-identity key (never the founder
 * key), so finality rests on the operator's coordinator set and never stalls when the local steward is
 * offline. The pubKey is carried so every node's master map is deterministic from genesis and finality
 * starts immediately, without waiting for pubkeys to propagate via gossip. Their accounts hold no funds
 * and isMaster/zti are not part of the state root, so seeding them is consensus-root-neutral.
 */
export interface GenesisMaster {
  address: Address;
  pubKey: PublicKey;
}

export interface GenesisDoc {
  network: NetworkId;
  timestamp: number;          // fixed, part of the hash
  founder: Address;           // the genesis steward, administers the reserve
  founders?: Address[];       // deterministic active founder set; includes founder when present
  masters?: GenesisMaster[];  // bootstrap finality quorum: keyless coordinator nodes that finalize by quorum
  reserveUZIR: uZIR;          // the 41 percent genesis reserve, seeded at block 0 (anchor + events + founder ops)
  allocations: GenesisAllocation[];
  anchors?: AnchorCodeCommitment[];
  anchorOwnership?: AnchorGenesisOwnership[];
  message: string;            // a human note, like bitcoin's headline
}

/** The canonical genesis id. All nodes must compute the same value to be on the same network. */
export function genesisId(doc: GenesisDoc): Hex {
  return hashHex(canonical(doc as unknown as Record<string, unknown>));
}

export interface GenesisState {
  balances: Record<Address, uZIR>;
  supply: { emitted: uZIR; burned: uZIR; reserve: uZIR };
}

/** Deterministically derive the seeded balances and supply from a genesis doc. */
export function applyGenesis(doc: GenesisDoc): GenesisState {
  const balances: Record<Address, uZIR> = {};
  for (const a of doc.allocations) {
    balances[a.address] = (balances[a.address] ?? 0) + a.amountUZIR;
  }
  return {
    balances,
    supply: { emitted: 0, burned: 0, reserve: doc.reserveUZIR },
  };
}

/**
 * A standard genesis doc. The founder administers the full genesis reserve and nothing else is issued.
 * Mainnet splits this reserve across the anchor reserve, the events reserve, and a small founder
 * operations slice in genesisFor(); this primitive keeps a single funded steward for devnet/tests.
 */
export function standardGenesis(network: NetworkId, founder: Address, timestamp: number, message?: string): GenesisDoc {
  return {
    network,
    timestamp,
    founder,
    reserveUZIR: PROTOCOL.RESERVE_UZIR,
    allocations: [
      { address: founder, amountUZIR: PROTOCOL.RESERVE_UZIR, note: "genesis reserve, granted over time" },
    ],
    anchors: [...DEFAULT_ANCHOR_CODE_COMMITMENTS],
    anchorOwnership: network === "mainnet" ? [...DEFAULT_MAINNET_ANCHOR_OWNERSHIP] : [],
    message: message ?? "ZIRA genesis. Trust is earned, never bought. The 59 percent is earned over time.",
  };
}
