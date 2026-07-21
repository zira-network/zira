// node/test/image-service.test.ts
// G1 safety + the T2I service wiring (2.9.0 A5-wire). Proves: the safety gate denies prohibited prompts and
// allows benign ones; the service refuses to generate a prohibited prompt, produces a valid commitment for a
// benign one via an injected engine, and its commitments settle through the coordinator by perceptual
// agreement. Uses a mock engine so no SD binary is required.
import test from "node:test";
import assert from "node:assert/strict";
import { ImageCoordinator } from "../src/image/ImageCoordinator.js";
import { ImageService } from "../src/image/ImageService.js";
import { screenImagePrompt } from "../src/image/ImageSafety.js";
import { dHash } from "@zira/protocol";

function img(fx: number, fy: number, noise = 0): Uint8Array {
  const w = 64, h = 64, px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const base = ((x * fx + y * fy) % 32) * 8;
    const j = noise ? ((x * 7 + y * 13) % (2 * noise + 1)) - noise : 0;
    px[y * w + x] = Math.max(0, Math.min(255, base + j));
  }
  return px;
}
// A mock engine that "generates" a fixed pattern (with per-provider drift) so commitments perceptually agree.
function mockEngine(noise: number): any {
  return {
    available: () => true,
    generate: async () => ({ pngPath: "/tmp/out.png", pHash: dHash(img(3, 1, noise), 64, 64), width: 64, height: 64 }),
  };
}

test("G1 safety: denies prohibited prompts, allows benign ones", () => {
  assert.equal(screenImagePrompt("a serene mountain lake at dawn").allowed, true);
  assert.equal(screenImagePrompt("child nude").allowed, false);
  assert.equal(screenImagePrompt("a portrait of a child playing in a park").allowed, true); // minor alone: ok
  assert.equal(screenImagePrompt("naked toddler").allowed, false);                          // minor + sexual: denied
  assert.equal(screenImagePrompt("revenge porn of someone").allowed, false);
});

test("service refuses a prohibited prompt (no generation)", async () => {
  const c = new ImageCoordinator({ enabled: true });
  const job = c.openJob({ prompt: "underage nude", modelId: "sd-1.5", seed: 1, asker: "zir1a" }, 1000)!;
  const svc = new ImageService(c, mockEngine(0), "zir1p1", () => "/models/sd-1.5");
  const r = await svc.serveJob(job, "/tmp/o.png");
  assert.equal(r, null);
});

test("service generates a commitment for a benign prompt; two providers settle via agreement", async () => {
  const c = new ImageCoordinator({ enabled: true });
  const job = c.openJob({ prompt: "a lighthouse at dawn", modelId: "sd-1.5", seed: 7, asker: "zir1a" }, 1000)!;
  const p1 = new ImageService(c, mockEngine(0), "zir1p1", () => "/models/sd-1.5");
  const p2 = new ImageService(c, mockEngine(4), "zir1p2", () => "/models/sd-1.5");
  const r1 = await p1.serveJob(job, "/tmp/o1.png");
  const r2 = await p2.serveJob(job, "/tmp/o2.png");
  assert.ok(r1 && r2, "both produced commitments");
  c.addCommitment(job.jobId, r1!.commitment, 1001);
  const settle = c.addCommitment(job.jobId, r2!.commitment, 1002);
  assert.ok(settle && settle.agreed);
  assert.deepEqual(settle!.agreeingProviders, ["zir1p1", "zir1p2"]);
});

test("service is inert when the model is not held locally", async () => {
  const c = new ImageCoordinator({ enabled: true });
  const job = c.openJob({ prompt: "a red apple", modelId: "sd-1.5", seed: 3, asker: "zir1a" }, 1000)!;
  const svc = new ImageService(c, mockEngine(0), "zir1p1", () => null); // model not held
  assert.equal(await svc.serveJob(job, "/tmp/o.png"), null);
});
