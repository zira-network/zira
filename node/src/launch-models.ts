// node/src/launch-models.ts
//
// Genesis-trusted launch models. The smallest baseline model is pre-authorized for the network with a real
// founder-signed manifest — exactly the shape a gossiped announce carries — so EVERY storage/mining node
// registers it on startup and fetches it from its source URL via the normal model path (peer-first, then the
// link, with the content hash verified against meta.id). No live founder announce and no peer gossip are
// required, which is what makes the field answer from the first block: the VPS coordinators and any joining
// miner fetch and serve the baseline, so "join and mine" earns by serving real demand. The signature is over
// the canonical meta, so this cannot be forged, and the content-hash check means the URL cannot substitute a
// different model.
import type { ModelAnnounce } from "./models/types.js";
import type { NetworkId } from "@zira/protocol";

type SignedLaunchModel = { meta: ModelAnnounce["meta"]; founderPubKey: string; manifestSig: string };

// Gemma 3 1B IT Q4_K_M (~806 MB) — the smallest baseline, CPU-friendly so the VPS coordinators serve it.
const MAINNET_LAUNCH_MODELS: SignedLaunchModel[] = [
  {
    meta: {
      id: "8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135",
      name: "Gemma 3 1B IT Q4_K_M",
      arch: "gemma-3-1b",
      quant: "Q4_K_M",
      url: "https://huggingface.co/ggml-org/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf",
      type: "text",
      domains: ["general", "language", "reasoning", "education"],
      version: 1,
      sizeBytes: 806058240,
      chunkSize: 1048576,
      chunkCount: 769,
      ts: 1782555190562,
    },
    founderPubKey: "543e2501d434d7fce383d35b09f15132a7ec6f6eadec14635ff584c64a9c64ce",
    manifestSig: "5abc721d4733e88ee843bcddc1b8fea34e141805d1e5fdd08ff4eb2b801d8285cc3ceaca720b9a40ca57076442202f652bc1e4a515bc818ff49fcc63fb77c003",
  },
];

/**
 * The genesis-authorized launch-model announces for a network. Mainnet only; test networks seed models the
 * normal way. peerId/host are placeholders ("genesis") so the model-fetch path falls through to the URL.
 */
export function launchModelsFor(network: NetworkId): ModelAnnounce[] {
  if (network !== "mainnet") return [];
  return MAINNET_LAUNCH_MODELS.map((m) => ({
    meta: m.meta, founderPubKey: m.founderPubKey, manifestSig: m.manifestSig, peerId: "genesis", host: "", ts: 0,
  }));
}
