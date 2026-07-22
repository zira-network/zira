// apps/console/src/app/Images.tsx
// 2.9.0 (A6): the text-to-image surface. Ask the field for an image; when >=2 provider machines generate the
// same prompt and their outputs agree perceptually, the result settles and they are paid (the same coordinate-
// and-settle model as a field answer, adapted for images). DORMANT until a node has image generation armed
// (ZIRA_IMAGE_ENABLE) and an image model distributed: /image/submit returns { disabled } and this page shows a
// clear "coming soon" state instead of failing.
import { useRef, useState } from "react";
import { ImageIcon, Sparkles } from "lucide-react";
import { Card, Badge, Button, Input, Textarea, Select, PageHeader, Spinner } from "../components/ui";
import { ResonanceField } from "../components/ResonanceField";
import { NodeApi } from "../lib/nodeApi";
import { useZira } from "../store/useZira";

type Phase = "idle" | "submitting" | "waiting" | "settled" | "disabled" | "error";

const DEFAULT_MODEL = "sdxl-base-1.0"; // resolved to the distributed image model once one is announced

export function Images() {
  const { address } = useZira();
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState(1024);
  const [steps, setSteps] = useState(30);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPoll() { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }

  async function generate() {
    stopPoll();
    setProviders([]);
    setMessage("");
    if (!prompt.trim()) return;
    setPhase("submitting");
    try {
      const seed = Math.floor(Math.random() * 1_000_000_000);
      const r = await NodeApi.imageSubmit({ prompt: prompt.trim(), modelId: DEFAULT_MODEL, seed, params: { width: size, height: size, steps }, asker: address ?? "" });
      if (r.disabled) { setPhase("disabled"); setMessage(r.reason ?? "Image generation is coming soon."); return; }
      if (r.error || !r.jobId) { setPhase("error"); setMessage(r.error ?? "Could not start the image job."); return; }
      const jobId = r.jobId;
      setPhase("waiting");
      setMessage("Asking the field. Waiting for machines to generate and agree...");
      pollRef.current = setInterval(async () => {
        try {
          const res = await NodeApi.imageResult(jobId);
          if (res.settled) {
            stopPoll();
            setProviders(res.providers ?? []);
            setPhase("settled");
            setMessage("The field agreed on an image. It arrives from the answering machine.");
          }
        } catch { /* transient; keep polling */ }
      }, 2500);
    } catch (e) {
      setPhase("error");
      setMessage(e instanceof Error ? e.message : "Image generation is not available on this node.");
    }
  }

  const busy = phase === "submitting" || phase === "waiting";

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-5">
      <PageHeader
        title="Images"
        badge={<Badge tone="indigo">coming soon</Badge>}
        description="Ask the field to generate an image. Independent machines render your prompt and are paid when their results perceptually agree, so no single company is the source."
      />

      {/* Honest dormant hero: the image engine is built and dormant, not a missing model. The field is
          rendered calm (live={false}) to read as ready-but-idle rather than broken. */}
      <Card className="overflow-hidden !p-0">
        <div className="brand-rule" />
        <div className="grid items-center gap-4 p-5 md:grid-cols-[200px_minmax(0,1fr)]">
          <div className="order-1 flex flex-col items-center justify-center">
            <ResonanceField size={180} live={false} intensity={0.2} />
            <div className="mt-3 text-center text-[11px] uppercase tracking-[0.16em] text-faint">dormant</div>
          </div>
          <div className="order-2">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--indigo)]"><ImageIcon size={13} /> Built, not yet armed</div>
            <h2 className="mt-1 text-xl font-semibold text-text">Image generation is coming soon</h2>
            <p className="mt-1 text-sm text-muted">The coordinate-and-settle image pipeline is built into the node and dormant. It turns on once a node arms image generation and an image model is distributed across the field. Nothing is missing; the field is simply idle until then.</p>
          </div>
        </div>
      </Card>

      <Card>
        <label className="text-xs font-medium text-muted">Prompt</label>
        <Textarea
          rows={3}
          className="mt-1.5"
          placeholder="A lighthouse at dawn, soft mist, cinematic lighting"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <label className="text-[11px] uppercase tracking-wide text-faint">Size</label>
            <Select className="mt-1 w-full" value={String(size)} onChange={(e) => setSize(Number(e.target.value))}>
              <option value="512">512 x 512</option>
              <option value="768">768 x 768</option>
              <option value="1024">1024 x 1024</option>
            </Select>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-faint">Steps</label>
            <Input type="number" min={1} max={50} className="mt-1 w-full" value={steps} onChange={(e) => setSteps(Math.max(1, Math.min(50, Number(e.target.value) || 30)))} />
          </div>
          <div className="flex items-end">
            <Button variant="primary" className="w-full" onClick={() => void generate()} disabled={busy || !prompt.trim()}>
              <Sparkles size={15} className="mr-1.5" /> {busy ? "Working..." : "Generate"}
            </Button>
          </div>
        </div>
      </Card>

      {/* Result / status */}
      {phase !== "idle" && (
        <Card>
          {phase === "disabled" ? (
            <div className="flex items-center gap-3 text-sm text-muted">
              <ImageIcon size={18} className="text-[var(--indigo)]" />
              <div><span className="text-text">Image generation is coming soon.</span> {message}</div>
            </div>
          ) : phase === "settled" ? (
            <div className="text-sm">
              <div className="text-text">{message}</div>
              {providers.length > 0 && <div className="mono mt-1.5 text-[11px] text-faint">Agreed by {providers.length} machine{providers.length === 1 ? "" : "s"}.</div>}
            </div>
          ) : phase === "error" ? (
            <div className="text-sm text-[var(--danger)]">{message}</div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted"><Spinner size={16} />{message}</div>
          )}
        </Card>
      )}
    </div>
  );
}
