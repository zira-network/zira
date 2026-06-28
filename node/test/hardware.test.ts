// node/test/hardware.test.ts
// Hardware detection is best-effort and must never throw, in any environment (including CI).
import test from "node:test";
import assert from "node:assert/strict";
import { detectHardware } from "../src/hardware/detect.js";

test("detectHardware resolves without throwing", async () => {
  const hw = await detectHardware();
  assert.ok(hw, "returns a profile");
});

test("detectHardware reports a positive core count and a platform", async () => {
  const hw = await detectHardware();
  assert.ok(hw.cpuCores > 0, "cpuCores > 0");
  assert.equal(typeof hw.platform, "string");
  assert.ok(hw.platform.length > 0);
});

test("detectHardware recommends at least 2 threads", async () => {
  const hw = await detectHardware();
  assert.ok(hw.recommendedThreads >= 2, "recommendedThreads >= 2");
});
