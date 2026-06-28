import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { keypairFromPrivate, hashHex, sign, verify } from "../src/crypto";
import { canonical } from "../src/serialize";

const path = resolve(__dirname, "vectors.json");

describe("shared test vectors", () => {
  it("vectors.json exists for the PHP side to reuse", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("regenerates the same canonical strings, ids, and verifiable signatures", () => {
    if (!existsSync(path)) return;
    const v = JSON.parse(readFileSync(path, "utf8"));
    const kp = keypairFromPrivate(v.testKey.privateKey);
    expect(kp.publicKey).toBe(v.testKey.publicKey);
    expect(kp.address).toBe(v.testKey.address);

    // observation
    expect(canonical(v.observation.body)).toBe(v.observation.canonical);
    expect(hashHex(v.observation.canonical)).toBe(v.observation.id);
    expect(verify(v.observation.canonical, v.observation.sig, kp.publicKey)).toBe(true);
    expect(sign(v.observation.canonical, kp.privateKey)).toBe(v.observation.sig);

    // tx
    expect(canonical(v.tx.body)).toBe(v.tx.canonical);
    expect(hashHex(v.tx.canonical)).toBe(v.tx.id);
    expect(verify(v.tx.canonical, v.tx.sig, kp.publicKey)).toBe(true);
  });
});
