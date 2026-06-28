// node/src/core/types.ts
// Wire envelopes gossiped between peers, and the node's account record.
import { hashHex } from "@zira/protocol";
import { canonical } from "@zira/protocol";
import type {
  SignedTx, SignedObservation, SignedCheckpointVote, Resonator, Task, PublicKey, Address, Domain, uZIR,
  ProviderProfile, ModelRecommendation,
} from "@zira/protocol";
import type { ModelAnnounce } from "../models/types.js";

export interface ProviderAnnounce {
  pubKey: PublicKey;
  address: Address;
  label: string;
  model: string;
  domains: Domain[];
  challenge: string;
  sig: string;
  ts: number;
}

export interface QueryMsg {
  id: string;
  domain: Domain;
  question: string;
  history: { role: "user" | "assistant"; content: string }[];
  asker: Address;
  postedAt: number;
}

export interface AnswerMsg {
  id: string;
  queryId: string;
  provider: PublicKey;
  answer: string;
  confidence: number;
  sig: string;
  ts: number;
}

// Everything that crosses the wire is one of these. Ledger events (tx, observation) feed the
// deterministic state machine. The rest is eventually consistent shared application data.
export type Envelope =
  | { t: "tx"; data: SignedTx }
  | { t: "observation"; data: SignedObservation }
  | { t: "checkpoint"; data: SignedCheckpointVote }
  | { t: "resonator"; data: Resonator }
  | { t: "task"; data: Task }
  | { t: "provider"; data: ProviderAnnounce }
  | { t: "providerProfile"; data: ProviderProfile }
  | { t: "recommendation"; data: ModelRecommendation }
  | { t: "query"; data: QueryMsg }
  | { t: "answer"; data: AnswerMsg }
  | { t: "model"; data: ModelAnnounce };

// A stable id per message used for dedup in our knownIds set. Ledger and consensus events use
// their own content id. Soft state (resonator, task, provider) is content hashed so a new version
// is a new id that propagates and overwrites, while an identical resend is ignored.
export function envelopeId(env: Envelope): string {
  switch (env.t) {
    case "tx": return "tx:" + env.data.id;
    case "observation": return "ob:" + env.data.id;
    case "checkpoint": return "cp:" + env.data.id;
    case "query": return "qy:" + env.data.id;
    case "answer": return "an:" + env.data.id;
    case "resonator": return "rs:" + hashHex(canonical(env.data as unknown as Record<string, unknown>));
    case "task": return "tk:" + hashHex(canonical(env.data as unknown as Record<string, unknown>));
    case "provider": return "pv:" + env.data.pubKey + ":" + env.data.ts;
    case "providerProfile": return "pp:" + env.data.address + ":" + env.data.updatedAt;
    case "recommendation": return "rc:" + env.data.id;
    case "model": return "ml:" + env.data.meta.id + ":" + env.data.peerId;
  }
}

export interface Account {
  address: Address;
  pubkey: PublicKey;
  balance: uZIR;
  nonce: number;
  zti: number;
  ztiByDomain: Partial<Record<Domain, number>>;
  accuracy: number;
  consistency: number;
  uptime: number;
  isMaster: boolean;
  // Sybil-resistant master admission bookkeeping (not part of the state root). firstSeenEpoch/activeEpochs
  // track how long an identity has genuinely participated; lastActiveEpoch guards the per-epoch increment.
  firstSeenEpoch: number;
  activeEpochs: number;
  lastActiveEpoch: number;
  // The last epoch this identity did verifiable on-ledger work (received a settled coordination payout).
  // Heartbeat emission and master tenure are gated on recent work, so empty heartbeats earn nothing.
  lastWorkEpoch: number;
}
