// node/src/devnet-seed.ts
// On devnet, a node can post a few simulated observations so Locks form and the field is alive
// before many real observers exist. Clearly devnet only. Three fixed observers near a drifting
// reference per subject. Never enabled on testnet or mainnet.
import { keypairFromPrivate, hashHex, canonical, buildObservationBody, sign as edSign, type Domain } from "@zira/protocol";
import type { ZiraNode } from "./core/ZiraNode.js";

// Multi-LLM coordination subjects. These are field-quality SIGNALS several models/observers score on a
// 0..1 scale — NOT hardware/energy/carbon/USD measurements: model answer quality, code-task pass rate,
// and reasoning benchmark accuracy. They use measurement-type domains (code/science/data) so they seed
// Locks via observations (the convention: measurement domains accept observations; the inference domains
// reasoning/language earn ZTI through query fusion receipts and are seeded as field queries below).
const SUBJECTS: { subject: string; domain: Domain; base: number }[] = [
  { subject: "MODEL_ANSWER_QUALITY",   domain: "science", base: 0.82 },  // benchmarked answer quality across models
  { subject: "CODE_INFERENCE_PASS",    domain: "code",    base: 0.69 },  // code-task pass / quality signal
  { subject: "REASONING_BENCH_SCORE",  domain: "science", base: 0.74 },  // reasoning benchmark accuracy
  { subject: "ANSWER_CONFIDENCE",      domain: "data",    base: 0.78 },  // coordinated/fused answer confidence
];
const INFERENCE_PROMPTS: { domain: Domain; question: string }[] = [
  { domain: "reasoning", question: "If a train leaves at 3pm at 60km/h, when is it 90km away?" },
  { domain: "language", question: "Summarize the value of decentralized multi-LLM inference in one sentence." },
  { domain: "code", question: "Write a one-line function that returns the nth Fibonacci number." },
];
const OBSERVERS = ["21", "22", "23"].map((b) => keypairFromPrivate(b.repeat(32)));

export function startDevnetSeed(node: ZiraNode): () => void {
  const tick = (): void => {
    const now = Date.now();
    for (const s of SUBJECTS) {
      const drift = Math.sin(now / 60000) * 0.01 * s.base;
      OBSERVERS.forEach((kp, i) => {
        const jitter = ((i + 1) * 0.003 - 0.006) * s.base;
        // These subjects are 0..1 quality scores, so keep the seeded value inside [0,1].
        const value = Number(Math.max(0, Math.min(1, s.base + drift + jitter)).toFixed(6));
        // Vary self-reported storage across the three seed observers (0 / 25 / 50 GiB) so the storage-weighted
        // emission split is visibly exercised on devnet: the 50 GiB observer earns the full bonus, the 0 GiB
        // one earns none. buildObservationBody is the single canonical source the validators also use.
        const body = buildObservationBody({
          type: "value", observer: kp.publicKey, timestamp: now, subject: s.subject,
          domain: s.domain, confidence: 0.85, sourceHashes: ["devnet-seed"], value,
          storageGiB: i * 25,
        });
        const c = canonical(body);
        const id = hashHex(c);
        const sig = edSign(c, kp.privateKey);
        node.submitObservation({ ...body, id, sig });
      });
    }
    // post a couple of inference-domain queries so reasoning/language providers can answer and earn ZTI.
    for (const p of INFERENCE_PROMPTS) {
      const id = "seed-" + p.domain + "-" + Math.floor(now / 20000);
      node.publishQuery({ id, domain: p.domain, question: p.question, history: [], asker: OBSERVERS[0]!.address, postedAt: now });
    }
  };
  tick();
  const iv = setInterval(tick, 4000);
  return () => clearInterval(iv);
}
