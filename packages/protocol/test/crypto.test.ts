import { describe, it, expect } from "vitest";
import {
  generateKeypair, keypairFromPrivate, addressFromPubKey, isValidAddress,
  sign, verify, hashHex,
} from "../src/crypto";
import { canonical } from "../src/serialize";

describe("crypto", () => {
  it("keypair signs and verifies", () => {
    const kp = generateKeypair();
    const msg = canonical({ b: 2, a: 1 });
    const sig = sign(msg, kp.privateKey);
    expect(verify(msg, sig, kp.publicKey)).toBe(true);
  });

  it("a tampered message fails verification", () => {
    const kp = generateKeypair();
    const sig = sign("hello", kp.privateKey);
    expect(verify("hell0", sig, kp.publicKey)).toBe(false);
  });

  it("an address round trips and a corrupted one is rejected", () => {
    const kp = generateKeypair();
    expect(kp.address.startsWith("zir1")).toBe(true);
    expect(isValidAddress(kp.address)).toBe(true);
    expect(addressFromPubKey(kp.publicKey)).toBe(kp.address);
    expect(isValidAddress(kp.address.slice(0, -1) + (kp.address.endsWith("a") ? "b" : "a"))).toBe(false);
    expect(isValidAddress("notanaddress")).toBe(false);
  });

  it("keypairFromPrivate is deterministic", () => {
    const priv = "1".repeat(64);
    const a = keypairFromPrivate(priv);
    const b = keypairFromPrivate(priv);
    expect(a.address).toBe(b.address);
    expect(a.publicKey).toBe(b.publicKey);
  });

  it("hashHex is stable and hex", () => {
    const h = hashHex("zira");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashHex("zira")).toBe(h);
  });
});

describe("canonical encoding", () => {
  it("is stable across key orders", () => {
    expect(canonical({ a: 1, b: 2, c: [3, 2, 1] })).toBe(canonical({ c: [3, 2, 1], b: 2, a: 1 }));
  });
  it("drops undefined optional keys", () => {
    expect(canonical({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it("nests deterministically", () => {
    expect(canonical({ z: { y: 1, x: 2 }, a: [{ b: 1, a: 2 }] }))
      .toBe('{"a":[{"a":2,"b":1}],"z":{"x":2,"y":1}}');
  });
});
