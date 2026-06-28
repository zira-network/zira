// node/test/provider-profile.test.ts
// A provider profile is a signed soft-state record. SoftState accepts a valid one and rejects a
// stale update (replay protection by updatedAt).
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeypair, verifyRecord, signRecord, DEFAULT_PROVIDER_CONFIG } from "@zira/protocol";
import { buildProviderProfile } from "../src/provider/profile.js";
import { SoftState } from "../src/core/SoftState.js";

test("buildProviderProfile produces a validly signed ProviderProfile", () => {
  const kp = generateKeypair();
  const profile = buildProviderProfile(kp, { ...DEFAULT_PROVIDER_CONFIG, label: "Test", domains: ["reasoning"] }, { tokensPerSec: 12, contextWindowTokens: 8192 });
  assert.equal(profile.address, kp.address);
  assert.equal(profile.pubKey, kp.publicKey);
  assert.ok(verifyRecord(profile), "profile verifies");
  assert.deepEqual(profile.domains, ["reasoning"]);
});

test("SoftState accepts a valid profile and rejects a stale update", () => {
  const kp = generateKeypair();
  const soft = new SoftState();
  const p1 = buildProviderProfile(kp, { ...DEFAULT_PROVIDER_CONFIG }, { tokensPerSec: 10, contextWindowTokens: 4096 });
  assert.equal(soft.upsertProviderProfile(p1), true);

  // a strictly newer profile (re-signed because content changed) is accepted
  const draft = { address: p1.address, label: p1.label, domains: p1.domains, tokensPerSec: p1.tokensPerSec,
    contextWindowTokens: p1.contextWindowTokens, supportsStreaming: p1.supportsStreaming, modelHint: p1.modelHint, updatedAt: p1.updatedAt + 1 };
  const p2signed = signRecord(draft, kp.privateKey);
  assert.equal(soft.upsertProviderProfile(p2signed as any), true);

  // an older one is rejected
  assert.equal(soft.upsertProviderProfile(p1), false);
});

test("SoftState rejects an unsigned profile", () => {
  const soft = new SoftState();
  const fake = { address: "zir1x", label: "x", domains: [], tokensPerSec: 0, contextWindowTokens: 0, supportsStreaming: false, updatedAt: 1, pubKey: "", sig: "" } as any;
  assert.equal(soft.upsertProviderProfile(fake), false);
});
