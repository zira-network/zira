// apps/console/src/components/HardwarePanel.tsx
// Informational only: shows the detected GPU/CPU/RAM so the user can understand this machine.
// ZIRA does not gate participation on hardware. There are no tuning sliders here.
import type { HardwareProfile } from "@zira/protocol";

export function HardwarePanel({ hardware, onRefresh, refreshing }: { hardware: HardwareProfile | null; onRefresh?: () => void; refreshing?: boolean }) {
  if (!hardware) {
    return (
      <div className="space-y-2 text-xs text-muted">
        <div className="font-medium text-text">Hardware profile requested</div>
        <div className="text-faint">The node will return CPU and RAM at minimum. If GPU drivers expose an accelerator, ZIRA will classify it automatically.</div>
        {onRefresh && <button onClick={onRefresh} disabled={refreshing} className="rounded-full border border-hairline px-2 py-1 text-[11px] text-muted hover:text-text disabled:opacity-50">{refreshing ? "Scanning..." : "Scan now"}</button>}
      </div>
    );
  }
  const vram = hardware.gpuVramMb ? `, ${(hardware.gpuVramMb / 1024).toFixed(1)} GB VRAM` : "";
  const gpus = hardware.gpus ?? [];
  const tier = hardware.capabilityTier ?? (hardware.recommendedMode === "gpu" ? "gpu-basic" : hardware.recommendedMode ?? "relay");
  const tierTone = tier.includes("gpu") ? "text-[var(--teal)]" : tier === "cpu" ? "text-[var(--indigo)]" : "text-muted";
  const cpuModel = hardware.cpuName ?? `${hardware.platform}/${hardware.arch ?? "unknown"}`;
  const bestGpu = hardware.gpuName ?? "No dedicated GPU exposed";
  return (
    <div className="space-y-3 text-xs text-muted">
      <div className="grid gap-2 lg:grid-cols-[1.2fr_1fr]">
        <div className="rounded-xl border border-[color-mix(in_srgb,var(--teal)_22%,var(--border))] bg-[color-mix(in_srgb,var(--teal)_8%,var(--bg-surface))] p-3">
          <div className="text-faint">Detected GPU / accelerator</div>
          <div className="mt-1 break-words text-sm font-semibold text-text">{bestGpu}</div>
          <div className="mono mt-1 text-[11px] text-[var(--teal)]">{hardware.gpuName ? `${(hardware.gpuVramMb ? (hardware.gpuVramMb / 1024).toFixed(1) : "?")} GB VRAM, ${hardware.gpus?.[0]?.vendor ?? "unknown"} ${hardware.gpus?.[0]?.kind ?? "accelerator"}` : "CPU and relay mode still supported"}</div>
        </div>
        <div className="rounded-xl border border-[color-mix(in_srgb,var(--indigo)_22%,var(--border))] bg-[color-mix(in_srgb,var(--indigo)_8%,var(--bg-surface))] p-3">
          <div className="text-faint">Detected CPU</div>
          <div className="mt-1 break-words text-sm font-semibold text-text">{cpuModel}</div>
          <div className="mono mt-1 text-[11px] text-[var(--indigo)]">{hardware.cpuCores} cores, {hardware.arch ?? "unknown arch"}</div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-hairline bg-surface/70 p-2">
          <div className="text-faint">Capability</div>
          <div className={`mono text-sm font-semibold ${tierTone}`}>{tier}</div>
        </div>
        <div className="rounded-lg border border-hairline bg-surface/70 p-2">
          <div className="text-faint">Mining fit</div>
          <div className="mono text-sm text-text">{hardware.recommendedRole ?? hardware.recommendedMode ?? "relay"}</div>
        </div>
        <div className="rounded-lg border border-hairline bg-surface/70 p-2">
          <div className="text-faint">RAM</div>
          <div className="mono text-sm text-text">{(hardware.ramMb / 1024).toFixed(0)} GB</div>
        </div>
      </div>

      <div className="space-y-1 font-mono">
        <div>Best GPU detail: {bestGpu}{vram}</div>
        {gpus.length > 0 && (
          <div className="text-faint">All accelerators: {gpus.map((g) => `${g.name}${g.vramMb ? ` (${(g.vramMb / 1024).toFixed(1)} GB)` : ""}`).join(", ")}</div>
        )}
        <div>Suggested mining: {hardware.recommendedRole ?? hardware.recommendedMode ?? "relay"}, {hardware.recommendedGpuLayers} GPU layers, {hardware.recommendedThreads} CPU threads</div>
      </div>

      <div className="rounded-lg border border-hairline bg-base/60 p-2">
        <div className="text-text">{hardware.miningHint ?? "Detected locally. Used to size mining defaults and show what this machine can contribute."}</div>
        <div className="mt-1 text-faint">
          Sources: {(hardware.detectionSources?.length ? hardware.detectionSources.join(", ") : "CPU/RAM runtime only")}
          {hardware.scanMs ? `, scan ${hardware.scanMs} ms` : ""}
        </div>
        {hardware.detectionWarnings?.length ? <div className="mt-1 text-faint">Skipped: {hardware.detectionWarnings.join(", ")}</div> : null}
      </div>

      {onRefresh && <button onClick={onRefresh} disabled={refreshing} className="rounded-full border border-hairline px-2 py-1 text-[11px] text-muted hover:border-hairline-strong hover:text-text disabled:opacity-50">{refreshing ? "Scanning hardware..." : "Rescan hardware"}</button>}
    </div>
  );
}
