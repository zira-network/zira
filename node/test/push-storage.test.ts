// Push-storage proof (Regime B, NAT-proof storage vouch): a miner proves it holds the model by hashing a
// salt-selected chunk; a master holding the same bytes re-derives the identical hash. Verifies symmetry,
// tamper/wrong-copy rejection, salt-dependence (unpredictable chunk), and that a non-holder cannot prove.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelService } from "../src/models/ModelService.js";
import { generateKeypair } from "@zira/protocol";

const ID = "testmodel0000000000000000000000000000000000000000000000000000abcd";
function gguf(fill: number): Buffer { return Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(60, fill)]); }
function storeWith(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "zira-ps-"));
  const md = join(dir, "models", ID);
  mkdirSync(md, { recursive: true });
  writeFileSync(join(md, "data.gguf"), bytes);
  writeFileSync(join(md, "meta.json"), JSON.stringify({ id: ID, name: "t", arch: "x", quant: "q", type: "text", domains: ["general"], sizeBytes: bytes.length, chunkSize: 16, chunkCount: Math.ceil(bytes.length / 16) }));
  return dir;
}
function svc(dir: string): ModelService {
  return new ModelService(dir, {} as never, generateKeypair(), () => [], () => {});
}

test("push-storage proof: symmetric, tamper/missing rejected, salt-dependent", () => {
  const salt = "salt-abc";
  const miner = svc(storeWith(gguf(7)));
  const master = svc(storeWith(gguf(7)));   // holds the SAME bytes = an honest verifier
  const wrong = svc(storeWith(gguf(9)));    // holds DIFFERENT bytes = wrong/partial copy
  const empty = svc(mkdtempSync(join(tmpdir(), "zira-ps-e-")));

  const proof = miner.storageProof(ID, salt);
  assert.ok(proof && typeof proof.hash === "string", "prover produces a proof");
  assert.equal(master.verifyStorageProof(ID, salt, proof!.hash), true, "same bytes verify");
  assert.equal(wrong.verifyStorageProof(ID, salt, proof!.hash), false, "different bytes rejected");
  assert.equal(master.verifyStorageProof(ID, salt, "deadbeef"), false, "wrong hash rejected");
  assert.equal(empty.storageProof(ID, salt), null, "non-holder cannot prove");
  const proof2 = miner.storageProof(ID, "salt-xyz");
  assert.notEqual(proof2?.hash, proof!.hash, "a different salt yields a different proof");
});
