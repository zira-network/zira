// apps/console/src/lib/buildAgent.ts
// The ZIRA build-agent loop. Turns a single model (field or local) into an iterative coding agent that works
// inside a user-opened folder: it reads the files it asks for, proposes writes, and proposes commands/tests,
// observing each result and continuing until the task is done or a step budget is reached. It is deliberately
// model-agnostic: the caller supplies `ask()` (one model turn -> raw text), so the same loop drives a network
// answer or the local machine. All filesystem + command access goes through the sandboxed desktop bridge
// (agentBridge), and every write and command is gated by the caller's approver so nothing touches disk or the
// shell without the user's explicit OK. This is what makes ZIRA usable for building real projects.
import { agentBridge, type WorkspaceFile } from "./platform";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "assistant"; text: string }
  | { type: "read"; path: string; ok: boolean; error?: string }
  | { type: "write"; path: string; ok: boolean; error?: string }
  | { type: "command"; command: string; code: number | null; output: string; timedOut?: boolean; ok: boolean; error?: string }
  | { type: "done"; text: string }
  | { type: "error"; text: string };

export interface AgentApprover {
  approveWrite: (path: string, content: string) => Promise<boolean>;
  approveCommand: (command: string) => Promise<boolean>;
}
export interface RunAgentArgs {
  goal: string;
  history?: { role: "user" | "assistant"; content: string }[];
  ask: (prompt: string, system: string) => Promise<string>;
  approver: AgentApprover;
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal;
  maxSteps?: number;
}

const SYSTEM = [
  "You are the ZIRA build-agent working INSIDE the user's project folder. Work in small, verifiable steps.",
  "You interact with the workspace ONLY through these directives, which the runtime executes and reports back:",
  "  [[READ path]]                     ask for a file's current contents (use before editing).",
  "  [[FILE path]]\\n<full new contents>\\n[[/FILE]]   create or overwrite a file with the EXACT full contents.",
  "  [[RUN]]<shell command>[[/RUN]]    run a command in the project root (build, tests, etc.).",
  "  [[DONE]] <one-line summary>       stop: the task is complete.",
  "Rules: emit ONLY what you need this step. Prefer reading before writing. After a write or command you will",
  "see the result and can continue. Keep prose short; put changes in [[FILE]] blocks, not in prose. Never invent",
  "file contents you have not read. If the task is done or blocked, emit [[DONE]] with a short summary.",
].join("\n");

const READ_RE = /\[\[READ\s+([^\]]+)\]\]/g;
const FILE_RE = /\[\[FILE\s+([^\]]+)\]\]\n?([\s\S]*?)\[\[\/FILE\]\]/g;
const RUN_RE = /\[\[RUN\]\]([\s\S]*?)\[\[\/RUN\]\]/g;
const DONE_RE = /\[\[DONE\]\]\s*([^\n]*)/;

function fileTree(files: WorkspaceFile[]): string {
  return files.slice(0, 400).map((f) => (f.dir ? f.path + "/" : f.path)).join("\n");
}

/** Run the iterative build-agent loop. Resolves when the agent finishes, is stopped, or hits the step budget. */
export async function runBuildAgent(args: RunAgentArgs): Promise<void> {
  const bridge = agentBridge();
  if (!bridge) { args.onEvent({ type: "error", text: "The build-agent runs in the desktop app (it needs sandboxed file and command access)." }); return; }
  const root = await bridge.workspace();
  if (!root) { args.onEvent({ type: "error", text: "Open a project folder first." }); return; }
  const maxSteps = Math.max(1, Math.min(40, args.maxSteps ?? 16));
  const listing = await bridge.listFiles();
  const transcript: string[] = [];
  transcript.push(`PROJECT ROOT: ${root}`);
  transcript.push(`FILES (partial):\n${fileTree(listing.files)}${listing.truncated ? "\n... (tree truncated)" : ""}`);
  transcript.push(`TASK: ${args.goal}`);

  for (let step = 0; step < maxSteps; step++) {
    if (args.signal?.aborted) { args.onEvent({ type: "status", text: "Stopped." }); return; }
    args.onEvent({ type: "status", text: `Step ${step + 1} of ${maxSteps}` });

    let reply = "";
    try { reply = await args.ask(transcript.join("\n\n"), SYSTEM); }
    catch (e) { args.onEvent({ type: "error", text: `Model call failed: ${(e as Error).message || e}` }); return; }
    if (args.signal?.aborted) return;

    // Show the model's narration (everything that is not a directive) so the user follows the reasoning.
    const narration = reply
      .replace(FILE_RE, "").replace(RUN_RE, "").replace(READ_RE, "").replace(DONE_RE, "").trim();
    if (narration) args.onEvent({ type: "assistant", text: narration });
    transcript.push(`ASSISTANT (step ${step + 1}):\n${reply}`);

    let didSomething = false;

    // 1) Reads first, so the same step's edits are informed by them next round.
    const reads = [...reply.matchAll(READ_RE)].map((m) => m[1]!.trim()).filter(Boolean);
    for (const rel of reads) {
      if (args.signal?.aborted) return;
      const res = await bridge.readFile(rel);
      args.onEvent({ type: "read", path: rel, ok: !!res.ok, error: res.error });
      transcript.push(res.ok ? `FILE ${rel}:\n${res.content}` : `READ ${rel} FAILED: ${res.error}`);
      didSomething = true;
    }

    // 2) Writes, each gated by the user.
    const writes = [...reply.matchAll(FILE_RE)].map((m) => ({ path: m[1]!.trim(), content: m[2] ?? "" }));
    for (const w of writes) {
      if (args.signal?.aborted) return;
      const ok = await args.approver.approveWrite(w.path, w.content);
      if (!ok) { args.onEvent({ type: "write", path: w.path, ok: false, error: "declined" }); transcript.push(`WRITE ${w.path} DECLINED by user`); didSomething = true; continue; }
      const res = await bridge.writeFile(w.path, w.content);
      args.onEvent({ type: "write", path: w.path, ok: !!res.ok, error: res.error });
      transcript.push(res.ok ? `WROTE ${w.path} (${w.content.length} bytes)` : `WRITE ${w.path} FAILED: ${res.error}`);
      didSomething = true;
    }

    // 3) Commands, each gated by the user; output fed back.
    const runs = [...reply.matchAll(RUN_RE)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
    for (const cmd of runs) {
      if (args.signal?.aborted) return;
      const ok = await args.approver.approveCommand(cmd);
      if (!ok) { args.onEvent({ type: "command", command: cmd, code: null, output: "", ok: false, error: "declined" }); transcript.push(`RUN "${cmd}" DECLINED by user`); didSomething = true; continue; }
      const res = await bridge.runCommand(cmd);
      const output = res.output ?? "";
      args.onEvent({ type: "command", command: cmd, code: res.code ?? null, output, timedOut: res.timedOut, ok: !!res.ok, error: res.error });
      transcript.push(`RAN "${cmd}" (exit ${res.timedOut ? "timeout" : res.code}):\n${output || res.error || "(no output)"}`);
      didSomething = true;
    }

    // 4) Done, or nothing actionable (the model just talked): stop so we never loop pointlessly.
    const done = reply.match(DONE_RE);
    if (done) { args.onEvent({ type: "done", text: (done[1] || "Done.").trim() }); return; }
    if (!didSomething) { args.onEvent({ type: "done", text: narration || "Done." }); return; }
  }
  args.onEvent({ type: "status", text: `Reached the ${maxSteps}-step limit. Send another message to continue.` });
}
