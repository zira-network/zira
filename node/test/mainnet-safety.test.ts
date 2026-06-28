import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, standardGenesis } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

class MemoryNetwork implements ZiraNetwork {
  constructor(
    private readonly addrs: string[] = [],
    private readonly peerAddrs: string[] = [],
    private readonly count = 0,
  ) {}
  start = async () => {};
  stop = async () => {};
  publish = async () => {};
  onMessage = () => {};
  setSyncProvider = () => {};
  onSyncFrame = () => {};
  handle = () => {};
  request = async () => [];
  onPeerConnect = () => {};
  dial = async () => {};
  multiaddrs = () => this.addrs;
  peerId = () => "memory-peer";
  peerCount = () => this.count;
  peers = () => [];
  peerMultiaddrs = () => this.peerAddrs;
}

test("mainnet ignores local founder backups for consensus authority", () => {
  const founder = keypairFromPrivate("11".repeat(32));
  const secondFounder = generateKeypair();
  const backup = generateKeypair();
  const genesis = { ...standardGenesis("mainnet", founder.address, 1_700_000_002_000), founders: [founder.address, secondFounder.address] };
  const node = new ZiraNode(genesis, founder, new MemoryNetwork(), join(tmpdir(), `zira-mainnet-safety-${process.pid}-${Date.now()}`));

  const r = node.setFounderBackups([backup.address]);
  assert.equal(r.ok, false);
  assert.deepEqual(new Set(node.founderAddresses()), new Set([founder.address, secondFounder.address]));
  assert.equal(node.state.isAuthorizedFounder(secondFounder.address), true);
  assert.equal(node.state.isAuthorizedFounder(backup.address), false);
});

test("non founder miners may answer through a local endpoint without gaining launch authority", async () => {
  const founder = keypairFromPrivate("12".repeat(32));
  const miner = generateKeypair();
  const genesis = standardGenesis("mainnet", founder.address, 1_700_000_003_000);
  const node = new ZiraNode(genesis, miner, new MemoryNetwork(), join(tmpdir(), `zira-mainnet-endpoint-${process.pid}-${Date.now()}`));

  await node.applyStatusPatch({
    mining: {
      enabled: true,
      endpoint: "http://127.0.0.1:11434/v1",
      endpointModel: "qwen2.5-coder:14b",
      localTaskPermission: true,
    },
  });

  const mining = await node.miningStatus();
  assert.equal(node.isFounder(), false);
  assert.equal(mining.endpoint, "http://127.0.0.1:11434/v1");
  assert.equal(mining.endpointModel, "qwen2.5-coder:14b");
  assert.equal(mining.answerLabel, "qwen2.5-coder:14b");
  assert.equal(mining.serving, true);
});

test("founder bootstrap registry candidates prefer public active seeds over local addresses", () => {
  const founder = keypairFromPrivate("13".repeat(32));
  const genesis = standardGenesis("mainnet", founder.address, 1_700_000_004_000);
  const net = new MemoryNetwork(
    ["/ip4/192.168.1.10/tcp/9645/p2p/local"],
    [
      "/dns4/community-seed.zira.network/tcp/9745/p2p/public-peer",
      "/ip4/10.0.0.2/tcp/9845/p2p/local-peer",
    ],
    2,
  );
  const node = new ZiraNode(genesis, founder, net, join(tmpdir(), `zira-mainnet-bootstrap-candidates-${process.pid}-${Date.now()}`));

  const view = node.bootstrapSeedCandidates({ publicHost: "seed.zira.network", publicHostType: "dns4", publicP2pPort: 9645 });
  const eligible = view.candidates.filter((seed) => seed.eligible);

  assert.equal(view.isFounder, true);
  assert.equal(eligible[0].multiaddr, "/dns4/seed.zira.network/tcp/9645/p2p/memory-peer");
  assert.equal(eligible[0].status, "public-unchecked");
  assert.ok(eligible.every((seed) => !seed.multiaddr.includes("/ip4/10.") && !seed.multiaddr.includes("/ip4/192.168.")));
  assert.ok(view.candidates.some((seed) => seed.status === "local"));
});
