// packages/protocol/src/client.ts
import type {
  Address, PublicKey, SignedTx, SignedObservation, Lock, FieldNode, Stream, Bond,
  Resonator, SpendLimits, Anchor, NetworkStats, AnswerReceipt, Listing, Task, PendingQuery, uZIR,
} from "./types";
import type { Domain } from "./constants";

export interface ZiraClient {
  // wallet and ledger. Keys live in the browser. The client submits signed objects only.
  getBalanceUZIR(address: Address): Promise<uZIR>;
  getNonce(address: Address): Promise<number>;
  submitTx(tx: SignedTx): Promise<{ accepted: boolean; reason?: string }>;
  getTxHistory(address: Address, limit?: number): Promise<SignedTx[]>;
  getTx(id: string): Promise<SignedTx | null>;
  getBonds(address: Address): Promise<Bond[]>;
  openStream(s: Omit<Stream, "id" | "startedAt" | "active">): Promise<Stream>;
  closeStream(id: string): Promise<void>;

  // field, read
  getFieldNodes(subject: string): Promise<FieldNode[]>;
  getRecentLocks(limit?: number): Promise<Lock[]>;
  getResonantValue(subject: string): Promise<Lock | null>;
  getRecentEvents(limit?: number): Promise<SignedTx[]>;
  submitObservation(o: SignedObservation): Promise<{ accepted: boolean; reason?: string }>;

  // the field assistant. The question goes to the providers, not a company API.
  askField(args: {
    question: string;
    history: { role: "user" | "assistant"; content: string }[];
    asker: Address;                       // who pays
    paymentTx?: SignedTx;                 // optional. In P2P the asker tips providers after answers.
    onToken: (t: string) => void;
    signal?: AbortSignal;
  }): Promise<{ answer: string; receipt: AnswerReceipt }>;

  // provider mode, intelligent mining in the browser
  registerProvider(p: { pubKey: PublicKey; label: string; model: string; domains: Domain[]; sig: string; challenge: string }): Promise<void>;
  pollQueries(domains: Domain[], pubKey: PublicKey): Promise<PendingQuery[]>;
  submitAnswer(a: { queryId: string; provider: PublicKey; answer: string; confidence: number; sig: string }): Promise<{ rewardedUZIR: uZIR }>;
  submitObservationBatch(obs: SignedObservation[]): Promise<{ accepted: number }>;

  // resonators and marketplace
  listResonators(owner: Address): Promise<Resonator[]>;
  createResonator(r: Omit<Resonator, "id" | "zti" | "ztiByDomain" | "balanceUZIR" | "totalEarnedUZIR" | "totalSpentUZIR" | "jobsDone" | "createdAt" | "updatedAt" | "status" | "pubKey" | "sig">): Promise<Resonator>;
  getResonator(id: string): Promise<Resonator | null>;
  updateResonator(id: string, patch: Partial<Resonator>): Promise<Resonator>;
  // Transfer a Resonator to another ZIR address (spec §7). Signed by the current owner; the node accepts
  // the owner change only with the current owner's signature, after which the new owner controls it.
  transferResonator(id: string, newOwner: Address): Promise<Resonator>;
  setResonance(id: string, on: boolean): Promise<Resonator>;
  setSpendLimits(id: string, limits: SpendLimits): Promise<Resonator>;
  fundResonator(id: string, fundingTx: SignedTx): Promise<Resonator>;
  withdrawResonator(id: string, withdrawTx: SignedTx): Promise<Resonator>;
  getMarketplace(args: { sort: "zti" | "price" | "jobs" | "recent" | "domainZti"; domain?: Domain; q?: string; limit?: number }): Promise<Listing[]>;
  hireResonator(args: { resonatorId: string; brief: string; domain: Domain; paymentTx: SignedTx; founderFeeTx?: SignedTx; minZti: number }): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  listTasks(client: Address): Promise<Task[]>;
  listResonatorTasks(resonatorId: string): Promise<Task[]>;

  // anchors, network, founder
  listAnchors(): Promise<Anchor[]>;
  getStats(): Promise<NetworkStats>;
  // founder only, gated by a signed challenge proving the genesis key
  grantReserve(grantTx: SignedTx, reason: string, challenge: string, challengeSig: string): Promise<{ accepted: boolean; reason?: string }>;
  getReserveGrants(limit?: number): Promise<SignedTx[]>;
}

// REST mapping the coordinator implements. All POST bodies and GET responses are JSON.
// GET  /api/balance?address=         -> { uZIR }
// GET  /api/nonce?address=           -> { nonce }
// POST /api/tx            { tx }      -> { accepted, reason? }
// GET  /api/tx/history?address=&limit=
// GET  /api/tx?id=
// GET  /api/locks?limit=             GET /api/value?subject=     GET /api/events?limit=
// POST /api/observation   { obs }    POST /api/observations { obs[] }
// POST /api/ask           { question, history, asker, paymentTx }  -> streamed text, then { receipt }
// POST /api/provider/register        GET /api/provider/poll?domains=
// POST /api/provider/answer
// GET  /api/resonators?owner=        POST /api/resonators ... PATCH /api/resonators/:id
// POST /api/resonators/:id/fund      POST /api/resonators/:id/withdraw
// GET  /api/marketplace?sort=&domain=&q=&limit=
// POST /api/hire          GET /api/tasks?client=    GET /api/task?id=
// GET  /api/anchors       GET /api/stats
// POST /api/founder/grant { grantTx, reason }   GET /api/founder/grants
