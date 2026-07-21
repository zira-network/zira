// node/src/image/ImageEngine.ts
// A1: the stable-diffusion.cpp engine adapter for text-to-image (2.9.0 Track A), SUBPROCESS-isolated and
// DORMANT until the binary is bundled + ZIRA_IMAGE_ENABLE=1.
//
// Mirrors the LLM engine's graceful-unavailable contract (Inference.available()): a node without the native
// SD binary runs perfectly and simply reports image serving unavailable. Generation runs in a CHILD PROCESS
// (never in-process) because SD is heavy and crash-prone and a crash must NEVER touch node RPC/consensus (the
// gemma-4-e4b crash-loop lesson). The provider computes a perceptual hash (protocol dHash) of the output and
// commits it via ImageCoordinator; the raw image bytes are delivered to the asker out of band and never enter
// consensus.
//
// The stable-diffusion.cpp binary is located via ZIRA_SD_BIN, else a bundled path (like the llama-bundle).
// Until that binary ships, available() is false and every path here is inert.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { dHash, normalizeImageParams, type ImageParams } from "@zira/protocol";
import { decodePngToLuma } from "./pngLuma.js";

const GEN_TIMEOUT_MS = Number(process.env.ZIRA_IMAGE_TIMEOUT_MS) || 180_000;

export interface ImageGenRequest {
  prompt: string;
  params?: Partial<ImageParams>;
  seed: number;
  modelPath: string; // the local SD model file (fetched via the storage network)
  outPath: string;   // where the subprocess writes the PNG
}

export interface ImageGenResult {
  pngPath: string;
  /** Perceptual hash (protocol dHash) of the generated image, for the ImageCommitment. */
  pHash: string;
  width: number;
  height: number;
}

/** Decode a PNG (or other) image file to row-major 8-bit grayscale luma. Wired at integration: the default
 * decoder is intentionally absent so this module carries no heavy image dependency while dormant. Inject a
 * decoder (e.g. a bundled native decode, or reading the sd binary's raw output) before arming. */
export type LumaDecoder = (file: string) => { luma: Uint8Array; width: number; height: number };

export class ImageEngine {
  private binPath: string | null;
  private decode: LumaDecoder | null;

  constructor(opts: { binPath?: string; decoder?: LumaDecoder } = {}) {
    this.binPath = opts.binPath ?? this.locateBinary();
    // Built-in PNG decoder by default (stable-diffusion.cpp writes PNG); overridable for tests / other formats.
    this.decode = opts.decoder ?? decodePngToLuma;
  }

  private locateBinary(): string | null {
    const env = process.env.ZIRA_SD_BIN;
    if (env && existsSync(env)) return env;
    // Bundled path candidates (the per-platform stable-diffusion.cpp bundle, like llama-bundle). leejet's
    // prebuilt CLI is named `sd-cli`; older builds used `sd`. Search the app resources dir and the cwd.
    const names = process.platform === "win32" ? ["sd-cli.exe", "sd.exe"] : ["sd-cli", "sd"];
    const roots = [process.env.ZIRA_SD_BUNDLE_DIR, join(process.cwd(), "sd-bundle"), join(process.cwd(), "core", "sd-bundle")].filter(Boolean) as string[];
    for (const root of roots) for (const name of names) {
      const p = join(root, name);
      if (existsSync(p)) return p;
    }
    return null;
  }

  /** True only when image serving is armed AND the binary + a decoder are present. Inert (false) otherwise, so
   * a node without the SD engine advertises no image capability and is never asked to generate. */
  available(): boolean {
    return process.env.ZIRA_IMAGE_ENABLE === "1" && !!this.binPath && !!this.decode;
  }

  /** Generate one image in an isolated subprocess. Returns null (never throws into the caller's consensus path)
   * when unavailable or on failure. The perceptual hash is computed here for the provider's commitment. */
  async generate(req: ImageGenRequest): Promise<ImageGenResult | null> {
    if (!this.available() || !this.binPath || !this.decode) return null;
    const p = normalizeImageParams(req.params);
    const args = [
      "-M", "img_gen",
      "-m", req.modelPath,
      "-p", String(req.prompt).slice(0, 4000),
      "-n", p.negativePrompt,
      "--seed", String(req.seed),
      "--steps", String(p.steps),
      "--cfg-scale", String(p.cfg),
      "-W", String(p.width),
      "-H", String(p.height),
      "--sampling-method", p.sampler,
      "-o", req.outPath,
    ];
    const ok = await this.runIsolated(this.binPath, args).catch(() => false);
    if (!ok || !existsSync(req.outPath)) return null;
    try {
      const { luma, width, height } = this.decode(req.outPath);
      return { pngPath: req.outPath, pHash: dHash(luma, width, height), width, height };
    } catch {
      return null;
    }
  }

  private runIsolated(bin: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(bin, args, { stdio: "ignore" });
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } resolve(false); }, GEN_TIMEOUT_MS);
      child.on("error", () => { clearTimeout(timer); resolve(false); });
      child.on("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
    });
  }
}
