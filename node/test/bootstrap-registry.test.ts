// node/test/bootstrap-registry.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { keypairFromPrivate, signRecord } from "@zira/protocol";
import { resolveBootstrapPeers, verifyBootstrapRegistry, type BootstrapSeedRegistry } from "../src/p2p/bootstrapRegistry.js";

const founder = keypairFromPrivate("01".repeat(32));
const peer = "/ip4/127.0.0.1/tcp/9645/p2p/12D3KooWEjNPNAEJ6wyrSb7G35U4UZMj6UdwWZBRrL2jYk8ohwrP";
const communityPeer = "/ip4/127.0.0.1/tcp/9646/p2p/12D3KooWEjNPNAEJ6wyrSb7G35U4UZMj6UdwWZBRrL2jYk8ohwrP";
const masterPeer = "/ip4/127.0.0.1/tcp/9647/p2p/12D3KooWEjNPNAEJ6wyrSb7G35U4UZMj6UdwWZBRrL2jYk8ohwrP";

function signedRegistry(seed = peer): BootstrapSeedRegistry {
  return signRecord({
    version: 1,
    network: "devnet",
    generatedAt: Date.now(),
    seeds: [{ multiaddr: seed, label: "test seed", roles: ["bootstrap"], priority: 1 }],
  }, founder.privateKey) as BootstrapSeedRegistry;
}

test("bootstrap registry verifies only under an authorized founder", () => {
  const registry = signedRegistry();
  assert.equal(verifyBootstrapRegistry(registry, {
    network: "devnet",
    authorizedFounders: [founder.address],
    requireSignature: true,
  }), true);
  assert.equal(verifyBootstrapRegistry(registry, {
    network: "devnet",
    authorizedFounders: ["zir1xjnm0y30k5uvzdzdkgfgl2hy2hemszqkh9kq93"],
    requireSignature: true,
  }), false);
});

test("bootstrap registry rejects expired or malformed seeds", () => {
  const expired = { ...signedRegistry(), expiresAt: Date.now() - 1 };
  assert.equal(verifyBootstrapRegistry(expired, {
    network: "devnet",
    authorizedFounders: [founder.address],
    requireSignature: true,
  }), false);
  const malformed = signedRegistry("not-a-multiaddr");
  assert.equal(verifyBootstrapRegistry(malformed, {
    network: "devnet",
    authorizedFounders: [founder.address],
    requireSignature: true,
  }), false);
});

test("resolver merges explicit peers with signed registry peers", async () => {
  const dir = join(tmpdir(), `zira-bootstrap-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const registryPath = join(dir, "bootstrap-seeds.json");
  writeFileSync(registryPath, JSON.stringify(signedRegistry(), null, 2));

  const explicit = "/ip4/127.0.0.1/tcp/9745/p2p/12D3KooWEjNPNAEJ6wyrSb7G35U4UZMj6UdwWZBRrL2jYk8ohwrP";
  const resolved = await resolveBootstrapPeers({
    explicit: [explicit],
    network: "devnet",
    dataDir: dir,
    authorizedFounders: [founder.address],
    auto: true,
    requireSignature: true,
    registryPath,
  });

  assert.deepEqual(resolved.peers, [explicit, peer]);
  assert.deepEqual(resolved.discovered, [peer]);
  assert.equal(resolved.registriesLoaded, 1);
});

test("resolver prefers master seed roles for fast first-contact sync", async () => {
  const dir = join(tmpdir(), `zira-bootstrap-ranked-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const registryPath = join(dir, "bootstrap-seeds.json");
  const registry = signRecord({
    version: 1,
    network: "devnet",
    generatedAt: Date.now(),
    seeds: [
      { multiaddr: communityPeer, label: "community", roles: ["community-seed"], priority: 1 },
      { multiaddr: masterPeer, label: "master", roles: ["master"], priority: 2 },
      { multiaddr: peer, label: "candidate", roles: ["master-candidate"], priority: 3 },
    ],
  }, founder.privateKey) as BootstrapSeedRegistry;
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  const resolved = await resolveBootstrapPeers({
    explicit: [],
    network: "devnet",
    dataDir: dir,
    authorizedFounders: [founder.address],
    auto: true,
    requireSignature: true,
    registryPath,
  });

  assert.deepEqual(resolved.discovered, [masterPeer, peer, communityPeer]);
});
