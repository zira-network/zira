// node/src/hardware/detect.ts
// Cross platform, best effort hardware detection. Never throws. Called at startup and on demand via
// GET /rpc/status. It powers intelligent mining defaults: relay-only, CPU, GPU, and storage guidance.
import os from "node:os";
import type { HardwareGpu, HardwareProfile } from "@zira/protocol";

function vendorOf(name: string): HardwareGpu["vendor"] {
  const n = name.toLowerCase();
  if (n.includes("nvidia") || n.includes("geforce") || n.includes("rtx") || n.includes("gtx")) return "nvidia";
  if (n.includes("amd") || n.includes("radeon")) return "amd";
  if (n.includes("intel")) return "intel";
  if (n.includes("apple")) return "apple";
  return "unknown";
}

function kindOf(name: string): HardwareGpu["kind"] {
  const n = name.toLowerCase();
  if (n.includes("intel") || n.includes("uhd") || n.includes("iris")) return "integrated";
  if (n.includes("nvidia") || n.includes("geforce") || n.includes("rtx") || n.includes("gtx") || n.includes("radeon")) return "discrete";
  return "unknown";
}

function addGpu(gpus: HardwareGpu[], gpu: HardwareGpu): void {
  const name = gpu.name.trim();
  if (!name) return;
  const existing = gpus.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (!existing.vramMb && gpu.vramMb) existing.vramMb = gpu.vramMb;
    existing.vendor ??= gpu.vendor;
    existing.kind ??= gpu.kind;
    return;
  }
  gpus.push({ ...gpu, name, vendor: gpu.vendor ?? vendorOf(name), kind: gpu.kind ?? kindOf(name) });
}

function parseMb(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const raw = String(v).replace(/,/g, "").trim();
  const n = Number(raw.match(/\d+(\.\d+)?/)?.[0] ?? 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/gib|gb/i.test(raw)) return Math.round(n * 1024);
  if (/kib|kb/i.test(raw)) return Math.round(n / 1024);
  return Math.round(n);
}

export async function detectHardware(): Promise<HardwareProfile> {
  const startedAt = Date.now();
  const cpuCores = os.cpus().length || 1;
  const cpuName = os.cpus()[0]?.model?.trim();
  const ramMb = Math.floor(os.totalmem() / 1_048_576);
  const platform = process.platform;
  const arch = process.arch;
  const gpus: HardwareGpu[] = [];
  const detectionSources: string[] = [];
  const detectionWarnings: string[] = [];

  try {
    const { execSync } = await import("node:child_process");
    const run = (cmd: string, timeout: number, source: string): string | null => {
      try {
        const out = execSync(cmd, { timeout, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        if (out.trim()) detectionSources.push(source);
        return out;
      } catch (e) {
        detectionWarnings.push(`${source} unavailable`);
        return null;
      }
    };

    if (platform === "win32") {
      const nvidia = run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits", 3500, "nvidia-smi");
      if (nvidia) {
        for (const line of nvidia.trim().split(/\r?\n/).filter(Boolean)) {
          const [n, v] = line.split(",");
          addGpu(gpus, { name: n ?? "", vramMb: parseMb(v), vendor: "nvidia", kind: "discrete" });
        }
      }

      // PowerShell CIM works on modern Windows where wmic is gone. AdapterRAM may be capped by the
      // driver, so NVIDIA VRAM from nvidia-smi wins when present.
      const ps = [
        "$ErrorActionPreference='SilentlyContinue';",
        "$cards=Get-CimInstance Win32_VideoController|Where-Object{$_.Name}|Select-Object Name,AdapterRAM,VideoProcessor;",
        "$cards|ConvertTo-Json -Compress",
      ].join("");
      const cim = run(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${ps}"`, 8000, "windows-cim");
      if (cim) {
        try {
          const parsed = JSON.parse(cim.trim());
          const cards = Array.isArray(parsed) ? parsed : [parsed];
          for (const c of cards) {
            const bytes = Number(c?.AdapterRAM ?? 0);
            addGpu(gpus, { name: String(c?.Name ?? c?.VideoProcessor ?? ""), vramMb: bytes > 0 ? Math.floor(bytes / 1_048_576) : null });
          }
        } catch {
          detectionWarnings.push("windows-cim parse failed");
        }
      }

      const wmic = run("wmic path win32_VideoController get Name,AdapterRAM /format:csv", 3500, "wmic-video");
      if (wmic) {
        for (const line of wmic.split(/\r?\n/).filter((l) => l.includes(","))) {
          const parts = line.split(",");
          const name = parts[2] ?? parts[1] ?? "";
          if (!name.trim() || name.trim().toLowerCase() === "name") continue;
          const bytes = Number(parts[1] ?? 0);
          addGpu(gpus, { name, vramMb: bytes > 0 ? Math.floor(bytes / 1_048_576) : null });
        }
      }
    } else if (platform === "linux") {
      const nvidia = run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits", 3500, "nvidia-smi");
      if (nvidia) {
        for (const line of nvidia.trim().split(/\r?\n/).filter(Boolean)) {
          const [n, v] = line.split(",");
          addGpu(gpus, { name: n ?? "", vramMb: parseMb(v), vendor: "nvidia", kind: "discrete" });
        }
      }
      const rocm = run("rocm-smi --showproductname --showmeminfo vram 2>/dev/null", 3500, "rocm-smi");
      if (rocm) {
        for (const line of rocm.split(/\r?\n/)) {
          if (/card|gpu/i.test(line) && /amd|radeon|instinct/i.test(line)) addGpu(gpus, { name: line.trim(), vramMb: null, vendor: "amd", kind: "discrete" });
        }
      }
      const lspci = run('lspci 2>/dev/null | grep -i "vga\\|3d\\|display"', 2500, "lspci");
      if (lspci) {
        for (const line of lspci.trim().split("\n").filter(Boolean)) addGpu(gpus, { name: line, vramMb: null });
      }
    } else if (platform === "darwin") {
      const out = run("system_profiler SPDisplaysDataType -json", 6000, "system-profiler");
      if (out) {
        for (const gpu of (JSON.parse(out) as any)?.SPDisplaysDataType ?? []) {
          const name = gpu?.sppci_model ?? gpu?._name ?? "";
          const vramStr: string = gpu?.vram ?? gpu?.spdisplays_vram ?? "";
          addGpu(gpus, { name, vramMb: parseMb(vramStr), vendor: vendorOf(name), kind: kindOf(name) });
        }
      }
    }
  } catch { /* best effort, leave nulls */ }

  // Prefer the GPU with the largest KNOWN VRAM; tie-break toward a discrete card. nvidia-smi reports real VRAM,
  // but AMD/Intel VRAM (driver AdapterRAM) is often 0/capped, which previously left non-Nvidia GPUs at 0 layers
  // = CPU-only ("only Nvidia can mine"). See the discrete fallback below.
  gpus.sort((a, b) => ((b.vramMb ?? 0) - (a.vramMb ?? 0)) || ((b.kind === "discrete" ? 1 : 0) - (a.kind === "discrete" ? 1 : 0)));
  const best = gpus[0];
  const gpuName = best?.name ?? null;
  // A DISCRETE GPU that reported no usable VRAM is still a real accelerator (AMD/Intel via Vulkan, Apple via
  // Metal). Give it a conservative default so it gets GPU layers instead of being pushed to CPU; the engine
  // (Inference.load) auto-picks the backend and falls back to CPU if the offload does not actually fit, so this
  // never bricks a machine. Integrated GPUs stay null (share system RAM, weak). Override: ZIRA_GPU_DEFAULT_VRAM_MB.
  const DISCRETE_DEFAULT_VRAM_MB = Number(process.env.ZIRA_GPU_DEFAULT_VRAM_MB ?? 6144);
  const gpuVramMb = best?.vramMb ?? (best?.kind === "discrete" ? DISCRETE_DEFAULT_VRAM_MB : null);
  // Heuristic: use the machine assertively by default; users can reduce this in Console if needed.
  const recommendedGpuLayers = gpuVramMb ? Math.min(Math.floor(gpuVramMb / 384), 100) : 0;
  const recommendedThreads = Math.max(2, cpuCores);
  const capabilityTier: HardwareProfile["capabilityTier"] = gpuVramMb && gpuVramMb >= 40_000 ? "gpu-heavy"
    : gpuVramMb && gpuVramMb >= 8_000 ? "gpu-strong"
      : gpuVramMb && gpuVramMb >= 4_000 ? "gpu-basic"
        : cpuCores >= 8 && ramMb >= 16_000 ? "cpu"
          : "relay";
  const recommendedMode: HardwareProfile["recommendedMode"] = capabilityTier.startsWith("gpu") ? "gpu" : capabilityTier === "cpu" ? "cpu" : "relay";
  const recommendedRole: HardwareProfile["recommendedRole"] = capabilityTier === "gpu-heavy" ? "storage-gpu"
    : capabilityTier === "gpu-strong" || capabilityTier === "gpu-basic" ? "gpu-miner"
      : capabilityTier === "cpu" ? "cpu-miner"
        : "relay";
  const acceleratorSummary = gpus.length
    ? gpus.map((g) => `${g.name}${g.vramMb ? ` (${Math.round(g.vramMb / 1024)} GB)` : ""}`).join(", ")
    : "No discrete accelerator detected";
  const miningHint = recommendedMode === "gpu"
    ? `${capabilityTier === "gpu-heavy" ? "Heavy GPU" : capabilityTier === "gpu-strong" ? "Strong GPU" : "GPU"} mining ready. Use ${recommendedGpuLayers} GPU layers and ${recommendedThreads} CPU threads as a starting point.`
    : recommendedMode === "cpu"
      ? `CPU mining ready. Use ${recommendedThreads} threads as a starting point.`
      : "Relay mining recommended. This node can still coordinate, relay, observe, and earn while heavier peers handle generation.";

  return {
    gpuName, gpuVramMb, gpus, acceleratorSummary,
    detectionSources: [...new Set(detectionSources)],
    detectionWarnings: [...new Set(detectionWarnings)].slice(0, 8),
    detectedAt: Date.now(),
    scanMs: Date.now() - startedAt,
    capabilityTier,
    cpuName,
    arch,
    cpuCores, ramMb, recommendedGpuLayers, recommendedThreads, recommendedMode, recommendedRole, miningHint, platform,
  };
}
