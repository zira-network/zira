// packages/protocol/scripts/genVectors.ts
//
// Generate the shared test vectors that BOTH the TypeScript and the PHP side reuse to
// prove their canonical encoders agree. Run with: pnpm gen:vectors
// The PHP parity test (server/tests/parity.php) loads the same file and asserts it
// produces identical canonical strings, ids, and verifies the same signatures.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keypairFromPrivate, hashHex, sign } from "../src/crypto";
import { buildObservationBody, buildTxBody, canonical } from "../src/serialize";

// A fixed, well known test private key (32 bytes of 0x01). NEVER use this for real funds.
const TEST_PRIV = "01".repeat(32);
const kp = keypairFromPrivate(TEST_PRIV);

const obsBody = buildObservationBody({
  type: "value",
  observer: kp.publicKey,
  timestamp: 1_700_000_000_000,
  // A multi-LLM coordination quality signal (0..1), not GPU/energy/carbon/USD: mean model answer
  // quality scored in the language domain. The encoding parity it proves is identical either way.
  subject: "MODEL_ANSWER_QUALITY",
  domain: "language",
  value: 0.82,
  confidence: 0.9,
  sourceHashes: ["aa", "bb"],
});
const obsCanonical = canonical(obsBody);
const obsId = hashHex(obsCanonical);
const obsSig = sign(obsCanonical, kp.privateKey);

const txBody = buildTxBody({
  network: "devnet",
  from: kp.address,
  fromPubKey: kp.publicKey,
  to: kp.address,
  amountUZIR: 1_000_000,
  feeUZIR: 1_000,
  nonce: 0,
  kind: "transfer",
  memo: "hello zira",
  parents: [],
  timestamp: 1_700_000_000_000,
});
const txCanonical = canonical(txBody);
const txId = hashHex(txCanonical);
const txSig = sign(txCanonical, kp.privateKey);

const vectors = {
  note: "Shared canonical encoding test vectors. TS and PHP must both reproduce these.",
  testKey: { privateKey: kp.privateKey, publicKey: kp.publicKey, address: kp.address },
  observation: { body: obsBody, canonical: obsCanonical, id: obsId, sig: obsSig },
  tx: { body: txBody, canonical: txCanonical, id: txId, sig: txSig },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, "..", "test", "vectors.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log("wrote", out);
console.log("address:", kp.address);
