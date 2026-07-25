// node/src/core/telemetry.ts
// Live, LOCAL machine + node telemetry for the Dashboard: CPU and RAM utilization and the node's own network
// bandwidth (bytes served/received through the RPC/Console HTTP server, the dominant ZIRA traffic: serving
// answers, reads, and model chunk transfers). Purely observational, per-process, never a consensus surface and
// never persisted. Rates are computed as deltas between successive samples (the Dashboard polls every few
// seconds), so the first sample after boot reports 0 rate until a second reading exists.
import { cpus, freemem, totalmem, loadavg } from "node:os";
import { exec } from "node:child_process";

// Live GPU utilization (0..1), sampled from nvidia-smi in the BACKGROUND so sampleTelemetry() never blocks
// the node's event loop on a subprocess. Refreshed at most every GPU_SAMPLE_MS; sampleTelemetry returns the
// last cached value (null until the first sample lands, and null on any machine without an NVIDIA GPU or
// nvidia-smi, in which case the UI simply renders 0/idle). Non-NVIDIA GPUs have no portable utilization CLI,
// so they stay null; this is observational only and never a consensus surface.
const GPU_SAMPLE_MS = 4000;
let gpuUtil: number | null = null;
let gpuSampling = false;
let gpuSampledAt = 0;
let gpuUnavailable = false; // set once nvidia-smi is confirmed missing, so we stop retrying every 4s
function refreshGpuUtilAsync(): void {
  if (gpuUnavailable || gpuSampling) return;
  const now = Date.now();
  if (gpuSampledAt && now - gpuSampledAt < GPU_SAMPLE_MS) return;
  gpuSampling = true;
  gpuSampledAt = now;
  exec("nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits", { timeout: 2500, windowsHide: true }, (err, stdout) => {
    gpuSampling = false;
    if (err) {
      // ENOENT (no nvidia-smi on PATH) means no NVIDIA tooling: stop retrying. Other errors are transient.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") gpuUnavailable = true;
      gpuUtil = null;
      return;
    }
    const vals = String(stdout).trim().split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    gpuUtil = vals.length ? Math.max(0, Math.min(1, (vals.reduce((a, b) => a + b, 0) / vals.length) / 100)) : null;
  });
}

// Cumulative bytes moved through the HTTP server since boot. countRx/countTx are called by the server on each
// request body read and response write. Numbers stay well within Number.MAX_SAFE_INTEGER for realistic uptimes.
let rxTotal = 0;
let txTotal = 0;
export function countRx(bytes: number): void { if (bytes > 0) rxTotal += bytes; }
export function countTx(bytes: number): void { if (bytes > 0) txTotal += bytes; }

// A soft bandwidth ceiling (KB/s) the operator sets; 0 = unlimited. Advisory today (surfaced so serving/fetch
// scheduling can honor it and the UI can show headroom); persisted by the caller alongside mining config.
let bandwidthCapKbps = Math.max(0, Math.floor(Number(process.env.ZIRA_BANDWIDTH_CAP_KBPS) || 0));
export function setBandwidthCapKbps(v: number): void { bandwidthCapKbps = Math.max(0, Math.floor(Number(v) || 0)); }
export function getBandwidthCapKbps(): number { return bandwidthCapKbps; }

// Highest observed total throughput (rx+tx KB/s), a cheap "auto-detected" sense of the link's real capacity so
// the UI can suggest a cap and show utilization without any OS-specific link-speed probing.
let peakKbps = 0;

type CpuSnap = { idle: number; total: number };
function cpuSnap(): CpuSnap {
  let idle = 0, total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let lastCpu: CpuSnap | null = null;
let lastAt = 0;
let lastRx = 0;
let lastTx = 0;

export interface Telemetry {
  cpuUtil: number;        // 0..1 share of CPU busy since the last sample
  gpuUtil: number | null; // 0..1 NVIDIA GPU utilization, or null when unavailable (non-NVIDIA / no nvidia-smi)
  loadAvg1: number;       // 1-minute load average (0 on platforms that do not report it)
  ramUsedFrac: number;    // 0..1
  ramUsedGb: number;
  ramTotalGb: number;
  rxBytesPerSec: number;  // node HTTP inbound rate
  txBytesPerSec: number;  // node HTTP outbound rate (serving)
  rxTotalBytes: number;
  txTotalBytes: number;
  bandwidthCapKbps: number; // operator cap, 0 = unlimited
  autoKbps: number;         // observed peak throughput (a sensible auto value)
}

/** Sample live telemetry. Rates are per-second deltas since the previous call. Cheap; safe to call per poll. */
export function sampleTelemetry(): Telemetry {
  const now = Date.now();
  refreshGpuUtilAsync(); // kick a background GPU sample; returns the cached value below without blocking
  const snap = cpuSnap();

  let cpuUtil = 0;
  if (lastCpu) {
    const idleD = snap.idle - lastCpu.idle;
    const totalD = snap.total - lastCpu.total;
    cpuUtil = totalD > 0 ? Math.max(0, Math.min(1, 1 - idleD / totalD)) : 0;
  }
  lastCpu = snap;

  const dtSec = lastAt ? Math.max(0.001, (now - lastAt) / 1000) : 0;
  const rxRate = dtSec ? Math.max(0, (rxTotal - lastRx) / dtSec) : 0;
  const txRate = dtSec ? Math.max(0, (txTotal - lastTx) / dtSec) : 0;
  lastAt = now; lastRx = rxTotal; lastTx = txTotal;

  const kbps = (rxRate + txRate) / 1024;
  if (kbps > peakKbps) peakKbps = kbps;

  const total = totalmem();
  const used = total - freemem();

  return {
    cpuUtil,
    gpuUtil,
    loadAvg1: loadavg()[0] ?? 0,
    ramUsedFrac: total > 0 ? used / total : 0,
    ramUsedGb: used / 1024 ** 3,
    ramTotalGb: total / 1024 ** 3,
    rxBytesPerSec: rxRate,
    txBytesPerSec: txRate,
    rxTotalBytes: rxTotal,
    txTotalBytes: txTotal,
    bandwidthCapKbps,
    autoKbps: Math.round(peakKbps),
  };
}
