// node/src/models/types.ts
// The peer to peer model field. Today the launch path accepts GGUF language/reasoning models by link.
// The same signed metadata shape is intentionally capability-tagged for later image, video, audio,
// tool, and multimodal models. The node content-addresses bytes by sha256, signs authorized entries,
// and gossips them. Peers get bytes from each other (a swarm) or, as fallback, from the signed link.
import type { Domain, ModelType } from "@zira/protocol";

export interface ModelMeta {
  id: string;          // sha256 hex of the GGUF file, the content address
  name: string;        // human label, for example "Qwen3 0.6B Q4_K_M"
  arch?: string;       // architecture hint, for example "qwen2"
  quant?: string;      // quantization, for example "Q4_K_M"
  sizeBytes: number;
  chunkSize: number;
  chunkCount: number;
  url?: string;        // the authorized source link; a fallback when no peer has it
  // The model MODALITY (type): text | code | image | video | audio | other. Lets the steward add many
  // model types over time and lets field queries/tasks route to the right kind of model. Older models
  // signed before this field default to "text" so existing authorizations stay valid.
  type?: ModelType;
  domains?: Domain[];  // capability/domain tags this model is good at, for type+domain routing
  // Free-form domain tags beyond the protocol domain taxonomy (e.g. "frontend", "rust", "radiology"),
  // so the steward can describe a model's specialty for discovery without changing the protocol enum.
  tags?: string[];
  version?: number;    // catalog version, so models can be revised over time
  // Steward assignment (v2.0.2): when true, this model was designated by the steward to spread across the
  // whole storage network, so every storage-enabled node fetches it even if it is already well replicated
  // (reconcileStorage prioritizes assigned models ahead of gap-filling). Part of the signed meta, so the
  // assignment is authenticated by the launch authority. Older models default to undefined (not assigned).
  assigned?: boolean;
  ts: number;
}

// Gossiped when a node holds a model and can serve it. The model is authorized by launch authority:
// founderPubKey and manifestSig prove an active steward signed this exact model. Any node that has the
// file may advertise it (peerId/host), but only authorized models are accepted into the
// field, so not just anyone can put a model on the network.
export interface ModelAnnounce {
  meta: ModelMeta;
  founderPubKey: string;   // active launch-authority public key
  manifestSig: string;     // launch-authority signature over the canonical meta
  peerId: string;          // a node currently serving the file
  host: string;            // that serving node's ZIRA address
  ts: number;
}

export interface MiningConfig {
  enabled: boolean;
  // auto: the node runs the authorized field model for you (you just lend compute).
  // select: you choose a specific model id from the field.
  mode: "auto" | "select";
  modelId: string | null;   // the chosen model in select mode (and the resolved one in auto)
  gpuLayers: number;        // layers offloaded to GPU, 0 means CPU only
  threads: number;          // CPU threads
  useRecommendedHardware?: boolean; // true = hardware scans may auto-size gpuLayers/threads
  // alternative to the built in engine: serve through an OpenAI compatible endpoint (for example
  // Ollama or LM Studio) running the model on your machine. This needs no native install.
  endpoint?: string;
  endpointModel?: string;
  localTaskPermission?: boolean; // allow workspace-style routed tasks without forcing a model download
  storageEnabled?: boolean;   // serve model/resonance bytes to peers; default is on with a small cap
  // Authoritative local cap for heavy peered bytes, in BYTES. Defaults to 1 GiB. The storage path never
  // exceeds this: replication stops and non-essential cached models are evicted to keep usage under it.
  storageCapBytes?: number;
  storageLimitGb?: number;    // legacy/display cap in GB, kept in sync with storageCapBytes for older UIs
  // "Use my hardware for my own tasks": run local inference (native GGUF engine if a model is loaded
  // locally, otherwise the configured local endpoint) for THIS user's own Console/Resonator tasks.
  // It is independent of mining: it never serves the field, never answers others, and never earns. A
  // user can enable this without ever mining. Mining (enabled) and own-tasks (ownTaskInference) are
  // distinct switches; the Console presents them as mutually exclusive states plus "off".
  ownTaskInference?: boolean;
}

// Default heavy-storage cap: 8 GiB. Storage peering is on by default, and the cap must be large enough to
// hold at least one full authorized model so a contributing node can actually SERVE the field's inference
// (the whole "miners answer, users need no local model" model) rather than evicting model bytes the moment
// they arrive. It is a LIMIT, not a reservation: a node only uses disk for what it actually replicates, so
// a light relay still stays small. Operators can raise it (storage role) or lower it in Settings.
export const STORAGE_DEFAULT_CAP_BYTES = 8 * 1024 ** 3; // 8 GiB

export const DEFAULT_MINING: MiningConfig = { enabled: false, mode: "auto", modelId: null, gpuLayers: 0, threads: 4, useRecommendedHardware: true, localTaskPermission: false, storageEnabled: true, storageCapBytes: STORAGE_DEFAULT_CAP_BYTES, storageLimitGb: 8, ownTaskInference: false };

export const MODEL_PROTOCOL = "/zira/model/1.0.0";
export const MODEL_CHUNK_BYTES = 1 << 20; // 1 MiB chunks
