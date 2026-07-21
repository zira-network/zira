// node/test/image-engine.test.ts
// The SD engine adapter (2.9.0 A1) is DORMANT until the binary is bundled + ZIRA_IMAGE_ENABLE=1 + a decoder is
// injected. Proves it advertises no capability and never generates while inert, and yields null (never throws
// into a caller's consensus path) when asked.
import test from "node:test";
import assert from "node:assert/strict";
import { ImageEngine } from "../src/image/ImageEngine.js";

test("dormant without a binary: available() is false and generate() returns null", async () => {
  const prev = process.env.ZIRA_IMAGE_ENABLE;
  process.env.ZIRA_IMAGE_ENABLE = "1"; // even armed, no binary/decoder => inert
  const eng = new ImageEngine({ binPath: undefined, decoder: undefined });
  assert.equal(eng.available(), false);
  const r = await eng.generate({ prompt: "a cat", seed: 1, modelPath: "/nope.gguf", outPath: "/nope.png" });
  assert.equal(r, null);
  if (prev === undefined) delete process.env.ZIRA_IMAGE_ENABLE; else process.env.ZIRA_IMAGE_ENABLE = prev;
});

test("disabled flag keeps it inert even if a binary+decoder are present", () => {
  const prev = process.env.ZIRA_IMAGE_ENABLE;
  delete process.env.ZIRA_IMAGE_ENABLE;
  const eng = new ImageEngine({ binPath: "/some/sd", decoder: () => ({ luma: new Uint8Array(64), width: 8, height: 8 }) });
  assert.equal(eng.available(), false); // flag off => dormant
  if (prev !== undefined) process.env.ZIRA_IMAGE_ENABLE = prev;
});
