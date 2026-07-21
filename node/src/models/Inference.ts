// node/src/models/Inference.ts
// The local inference engine for miners. It runs a distributed GGUF model on CPU or GPU using
// node-llama-cpp. The dependency is optional and loaded dynamically, so a node that does not mine
// (or a machine without the native engine) still runs perfectly; mining simply reports unavailable.
import { log } from "../log.js";

export interface LoadOptions { gpuLayers: number; threads: number; }

export class Inference {
  private llama: any = null;
  private model: any = null;
  private context: any = null;
  private loadedId: string | null = null;
  private available: boolean | null = null;

  /** True if the native engine can be loaded on this machine. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      // dynamic, optional. Absent on non miners or unsupported platforms.
      await import("node-llama-cpp" as string);
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  loadedModel(): string | null { return this.loadedId; }

  async load(modelId: string, modelPath: string, opts: LoadOptions): Promise<void> {
    if (this.loadedId === modelId && this.context) return;
    const mod: any = await import("node-llama-cpp" as string).catch(() => null);
    if (!mod) throw new Error("inference engine not installed. Run: pnpm add node-llama-cpp (desktop miners only).");
    await this.unload();
    // Cross-vendor GPU: "auto" picks the best backend AVAILABLE in the bundled engine (CUDA on Nvidia, Vulkan
    // on AMD/Intel, Metal on Apple) and otherwise CPU, so mining is not Nvidia-only. Override with
    // ZIRA_GPU_BACKEND=cuda|vulkan|metal|false (false = force CPU).
    const pref = process.env.ZIRA_GPU_BACKEND;
    const gpu = pref === "false" ? false : (pref || "auto");
    this.llama = await mod.getLlama({ gpu }).catch(async () => mod.getLlama({ gpu: false }));
    let gpuLayers = opts.gpuLayers;
    try {
      this.model = await this.llama.loadModel({ modelPath, gpuLayers });
    } catch (e) {
      // GPU offload failed (backend unsupported here / not enough VRAM). Fall back to CPU so the node still
      // mines instead of being excluded. Better a slower miner than a machine that cannot participate.
      if (gpuLayers > 0) {
        log.warn(`GPU offload failed (${(e as Error).message.slice(0, 90)}); retrying on CPU`);
        gpuLayers = 0;
        this.model = await this.llama.loadModel({ modelPath, gpuLayers: 0 });
      } else throw e;
    }
    this.context = await this.model.createContext({ threads: opts.threads, sequences: 4 });
    this.loadedId = modelId;
    log.info(`inference engine loaded model ${modelId.slice(0, 12)} backend=${this.llama?.gpu ?? "?"} gpuLayers=${gpuLayers} threads=${opts.threads}`);
  }

  async generate(system: string, messages: { role: "user" | "assistant"; content: string }[]): Promise<string> {
    if (!this.context) throw new Error("no model loaded");
    const mod: any = await import("node-llama-cpp" as string);
    // Capture and dispose the context sequence per call, or the slot pool exhausts ("No sequences left")
    // after a few generations and bricks own-task/native inference until reload (same fix as inferenceServer).
    const seq = this.context.getSequence();
    const session = new mod.LlamaChatSession({ contextSequence: seq, systemPrompt: system });
    try {
      // replay prior turns so the model has context, then answer the last user message
      const last = messages[messages.length - 1];
      for (const m of messages.slice(0, -1)) {
        if (m.role === "user") await session.prompt(m.content, { maxTokens: 1 }).catch(() => {});
      }
      const answer = await session.prompt(last?.content ?? "", { temperature: 0.6, maxTokens: 512 });
      return String(answer ?? "").trim();
    } finally {
      try { session.dispose?.(); } catch { /* */ }
      try { seq.dispose?.(); } catch { /* */ }
    }
  }

  async unload(): Promise<void> {
    try { await this.context?.dispose?.(); } catch { /* */ }
    try { await this.model?.dispose?.(); } catch { /* */ }
    this.context = null; this.model = null; this.loadedId = null;
  }
}
