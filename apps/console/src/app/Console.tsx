// apps/web/src/app/Console.tsx
// The chat home. The question goes to the field through askField, paid with a signed query fee,
// answered by providers' own models, and the answer carries a verifiable receipt.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Send, Square, ChevronDown, ChevronUp, CheckCircle2, Plus, Trash2, ShieldCheck, Download, Sparkles, Upload, FolderOpen, FileText, X, HelpCircle, Copy, ListChecks, Check, FilePlus, Compass, ArrowRight, Bot, Menu, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Coins, Cpu } from "lucide-react";
import { PROTOCOL, SPECIAL_ADDRESSES, verify as edVerify, type AnswerReceipt, type ChatMessage, type Conversation } from "@zira/protocol";
import { Button, Card, Badge, Meter, useToast, Spinner, Select } from "../components/ui";
import { HexField } from "../components/brand";
import { NodeApi, type FieldModel, type Pricing, type FreeTierQuota } from "../lib/nodeApi";
import { FreeTierError, NodeClient } from "../client/NodeClient";
import { useZira } from "../store/useZira";
import { useUi } from "../store/useUi";
import { formatZir, shortHash, shortAddress, formatNum, timeAgo } from "../lib/format";
import { isLocalNode } from "../client/createClient";

const STORE = "zira.conversations";
type ConsoleAnswerMode = "field" | "local";
type CoordinationProfile = "quick" | "balanced" | "deep";
// Field and Local workspace keep separate chat threads; a conversation remembers which mode it belongs to.
// A conversation can also belong to a Project: a named workspace that groups chats and carries shared
// standing instructions prepended to every task in it.
type ModeConvo = Conversation & { mode?: ConsoleAnswerMode; projectId?: string };
interface Project { id: string; name: string; instructions: string; createdAt: number }
const PROJECTS_KEY = "zira.console.projects";
function loadProjects(): Project[] {
  try { return JSON.parse(localStorage.getItem(PROJECTS_KEY) || "[]"); } catch { return []; }
}
interface WorkspaceAttachment { name: string; path: string; size: number; content: string; truncated: boolean }
interface WorkspaceEntry { name: string; kind: "file" | "directory" }
interface FileHandleLike {
  createWritable?: () => Promise<{ write: (data: string | Blob) => Promise<void>; close: () => Promise<void> }>;
}
interface DirectoryHandleLike {
  name: string;
  values?: () => AsyncIterable<{ name: string; kind: "file" | "directory" }>;
  requestPermission?: (opts: { mode: "readwrite" }) => Promise<"granted" | "denied" | "prompt">;
  getDirectoryHandle?: (name: string, opts?: { create?: boolean }) => Promise<DirectoryHandleLike>;
  getFileHandle?: (name: string, opts?: { create?: boolean }) => Promise<FileHandleLike>;
}
interface WorkspaceLocation { name: string; entries: WorkspaceEntry[]; truncated: boolean; writable: boolean; lastOutputPath?: string }
// A task the local agent works through, persisted in .zira/tasks.json so a session survives reloads.
type WorkspaceTaskStatus = "pending" | "active" | "done";
interface WorkspaceTask { id: string; title: string; status: WorkspaceTaskStatus; createdAt: number }
const MAX_WORKSPACE_FILES = 48;
const MAX_WORKSPACE_BYTES = 240_000;
const MAX_FILE_CHARS = 40_000;
const MAX_WORKSPACE_ENTRIES = 80;

function loadConvos(): ModeConvo[] {
  try { return JSON.parse(localStorage.getItem(STORE) || "[]"); } catch { return []; }
}
function saveConvos(c: Conversation[]) { localStorage.setItem(STORE, JSON.stringify(c)); }

function exportConvo(c: Conversation): void {
  const lines = [`# ${c.title}`, "", ...c.messages.map((m) => `**${m.role === "user" ? "You" : "ZIRA"}** - ${new Date(m.createdAt).toLocaleString()}\n\n${m.content}\n`)];
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `zira-chat-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Clarifying polls: the field is told to ask one multiple-choice question instead of guessing when a
// request is genuinely ambiguous. The Console parses that block and renders it as clickable options;
// picking one sends it back as the next turn so coordination continues with the clarification.
// Gating is deliberately conservative: the instruction is only attached when the request itself looks
// ambiguous (see looksAmbiguous), it is never attached when continuing from a clicked option/step, and
// it is suppressed for one turn right after a poll so the field cannot chain polls.
const POLL_INSTRUCTION =
  "\n\nDefault to answering directly. Do NOT ask a poll unless answering would force you to commit to one of several materially different interpretations of the request and no default is clearly better. If a reasonable default exists, take it and state the assumption in one short line instead of polling. Never poll to confirm, to be polite, to narrow scope you can infer, or two turns in a row. When (and only when) a clarifying poll is genuinely required, emit EXACTLY this block and nothing before it (2 to 4 distinct options, each a short phrase):\n[[POLL]]\n<your question>\n- <option one>\n- <option two>\n[[/POLL]]";

// A conservative client-side gate for whether a clarifying poll should even be OFFERED to the field.
// Most turns return false (just answer). We only allow a poll when the request has the shape of a
// genuinely ambiguous ask: it is short and open-ended, or it explicitly presents alternatives, or it
// asks for a recommendation/choice without enough constraints to pick a sensible default. This keeps
// polls rare; the field still makes the final call via POLL_INSTRUCTION.
function looksAmbiguous(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  const words = q.split(/\s+/).length;
  // Long, detailed requests almost always carry enough context to answer directly.
  if (words > 40) return false;
  const lower = q.toLowerCase();
  // Explicit either/or framing, or a request to choose between options.
  if (/\b(or|versus|vs\.?)\b/.test(lower) && /\?\s*$/.test(q)) return true;
  if (/\b(which|what)\s+(one|option|approach|way|stack|framework|language|tool)\b/.test(lower)) return true;
  // Open recommendation asks with no stated constraints ("recommend a ...", "help me pick ...").
  if (/\b(recommend|suggest|pick|choose|best)\b/.test(lower) && words <= 12) return true;
  // Very short, bare requests that could mean several things ("optimize this", "improve it").
  if (words <= 4 && /\b(this|it|that|them)\b/.test(lower)) return true;
  return false;
}

interface ParsedPoll { question: string; options: string[]; before: string; after: string }
function parsePoll(content: string): ParsedPoll | null {
  const m = content.match(/\[\[POLL\]\]([\s\S]*?)\[\[\/POLL\]\]/);
  if (!m) return null;
  const lines = m[1]!.split("\n").map((l) => l.trim()).filter(Boolean);
  const optLines = lines.filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean);
  const question = lines.find((l) => !/^[-*]\s+/.test(l)) ?? "";
  const options = [...new Set(optLines)].slice(0, 4);
  if (!question || options.length < 2) return null;
  return { question, options, before: content.slice(0, m.index!).trim(), after: content.slice(m.index! + m[0].length).trim() };
}

// Plan / steps: for a complex multi-step task the field may open with a short plan. The Console renders
// it as a numbered checklist whose steps are clickable — clicking sends that step back as the next turn
// so the user can drive the field through the plan one step at a time.
const PLAN_INSTRUCTION =
  "\n\nOnly if the request is a genuinely multi-step build or change (something that sensibly breaks into separate steps the user would work through one at a time) you MAY open with a short plan using EXACTLY this format (3 to 8 concise steps), then continue with the first step below it:\n[[PLAN]]\n- <step one>\n- <step two>\n[[/PLAN]]\nFor a question, an explanation, or any single-step request, do NOT include a plan: just answer.";

// A conservative client-side gate for whether a multi-step PLAN should even be OFFERED to the field.
// Mirrors the poll gate: most turns return false (just answer). A plan is only worth offering when the
// request genuinely reads as a multi-step build/change the user would work through one step at a time.
// Arithmetic, short asks, single questions, and explanations never qualify, so a weak model can't be
// nudged into emitting a spurious "[PLAN]" for something like "10+6".
function looksMultiStep(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  // Pure arithmetic or a bare expression is never a plan ("10+6", "12 * (3-1)", "2^8").
  if (/^[\d\s.+\-*/^%()=]+$/.test(q)) return false;
  const words = q.split(/\s+/).length;
  // Very short asks carry no multi-step shape.
  if (words < 6) return false;
  const lower = q.toLowerCase();
  // Explicit multi-part framing: "step by step", "and then", numbered/listed asks, "plan ...".
  if (/\b(step[-\s]?by[-\s]?step|one step at a time|then\b.*\bthen\b)\b/.test(lower)) return true;
  if (/\bplan\b.*\b(build|implement|migrat|refactor|set ?up|ship|launch|project|feature|app|pipeline)\b/.test(lower)) return true;
  // Build/change verbs paired with enough scope to warrant separable steps.
  const buildVerb = /\b(build|implement|create|set ?up|scaffold|refactor|migrat|integrat|design|add)\b/.test(lower);
  const scope = /\b(project|app|application|service|system|pipeline|feature|module|component|website|api|backend|frontend|workflow|architecture|database|schema)\b/.test(lower);
  if (buildVerb && scope && words >= 8) return true;
  // Conjoined multi-task asks ("do X and Y and Z", "X, then Y").
  if (/(,|\band\b).*(,|\band\b)/.test(lower) && buildVerb && words >= 10) return true;
  return false;
}

interface ParsedPlan { steps: string[]; before: string; after: string }
function parsePlan(content: string): ParsedPlan | null {
  const m = content.match(/\[\[PLAN\]\]([\s\S]*?)\[\[\/PLAN\]\]/);
  if (!m) return null;
  const steps = m[1]!.split("\n").map((l) => l.trim())
    .filter((l) => /^([-*]\s+|\d+[.)]\s*)/.test(l))
    .map((l) => l.replace(/^[-*]\s+|^\d+[.)]\s*/, "").trim())
    .filter(Boolean);
  if (steps.length < 2) return null;
  return { steps: steps.slice(0, 8), before: content.slice(0, m.index!).trim(), after: content.slice(m.index! + m[0].length).trim() };
}

// Defensive cleanup: a weak model may emit a [[PLAN]] block that is not a real plan (empty, or with
// fewer than two genuine steps, e.g. "[[PLAN]]\n10 + 6\n[[/PLAN]]"). parsePlan already rejects those so
// they never render as a Plan card, but the raw block would otherwise show verbatim in the answer body.
// Strip any PLAN block that parsePlan does not accept, keeping the prose around it. A valid plan is left
// intact so the real Plan card still renders.
function stripSpuriousPlan(content: string): string {
  return content.replace(/\[\[PLAN\]\]([\s\S]*?)\[\[\/PLAN\]\]/g, (whole) =>
    parsePlan(whole) ? whole : "").replace(/\n{3,}/g, "\n\n").trim();
}

// Local workspace file proposals (agentic-editor style). In Local mode the field may propose creating or
// editing project files. It never writes directly: it emits one or more [[FILE path]]...[[/FILE]] blocks,
// the Console parses them, and the user must approve each write before it touches the disk. This is the
// permissions model: file writes are proposed, shown with their full content and target path, and only
// applied on explicit approval.
const FILE_PROPOSAL_INSTRUCTION =
  "\n\nThis is a local coding workspace on the user's own machine. When the task calls for creating or changing a project file, do NOT print the file as a normal code block. Instead propose each file with EXACTLY this block (you may emit several), using a path relative to the chosen workspace folder:\n[[FILE path/to/file.ext]]\n<full new contents of the file>\n[[/FILE]]\nPropose the complete intended contents of each file, not a diff. Briefly explain the change in prose around the blocks. The user reviews and approves each write before anything is saved; nothing you propose is written automatically.";

interface ProposedFile { path: string; content: string }
// Parse [[FILE path]]...[[/FILE]] proposals out of an answer. Returns the cleaned prose (proposals
// removed) plus the list of proposed files, so the chat shows the explanation and a separate approval card.
function parseFileProposals(content: string): { files: ProposedFile[]; prose: string } {
  const re = /\[\[FILE\s+([^\]\n]+)\]\]\n?([\s\S]*?)\[\[\/FILE\]\]/g;
  const files: ProposedFile[] = [];
  let prose = content;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const path = m[1]!.trim().replace(/^[./\\]+/, "");
    if (path) files.push({ path, content: m[2]!.replace(/\n$/, "") });
  }
  if (files.length) prose = content.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
  return { files, prose };
}

export function Console() {
  const { client, mode, address, hasWallet, unlocked, mining, setMining, refreshStatus, hardware } = useZira();
  const toast = useToast();
  const [hwBusy, setHwBusy] = useState(false);
  // "Use my machine for my own tasks": run YOUR OWN questions privately on YOUR OWN hardware (local
  // inference for your queries). This is NOT mining: it does not serve the field, does not answer other
  // people, and earns no ZIR. It only toggles own-task local inference (ownTaskInference) and pulls the
  // model bytes this machine needs to answer you locally; it never flips the field-serving (mining) switch.
  // Mining (serving the field and earning ZIR) is a separate choice on the Mine tab.
  async function setUseMachine(on: boolean) {
    setHwBusy(true);
    try {
      if (on) await NodeApi.refreshHardware();
      // Local own-task inference needs room to hold the model bytes this machine answers you with. The
      // default 1GB cap is too small for a typical 2GB+ GGUF, so raise the cap to a sensible size when
      // turning it on (never lowering a larger cap the user already chose in Mine). We deliberately do NOT
      // touch `enabled` (mining): turning this on must never start serving the field.
      await setMining(on
        ? { ownTaskInference: true, storageEnabled: true, storageLimitGb: Math.max(20, Number(mining?.storageLimitGb) || 0) }
        : { ownTaskInference: false });
      await refreshStatus();
      toast.push(on
        ? "This machine now answers your own questions privately on your computer. This is not Mining and earns no ZIR. To help the network and earn, open the Mine tab."
        : "Stopped using this machine for your own tasks. Your questions go to the network: free within your allowance, or paid with ZIR.");
    } catch (e) { toast.push(e instanceof Error ? e.message : "could not update this machine", "danger"); }
    finally { setHwBusy(false); }
  }
  async function rescanHardware() {
    setHwBusy(true);
    try { await NodeApi.refreshHardware(); await refreshStatus(); toast.push("Hardware rescanned."); }
    catch (e) { toast.push(e instanceof Error ? e.message : "hardware scan failed", "danger"); }
    finally { setHwBusy(false); }
  }
  const hwSummary = hardware?.acceleratorSummary ?? hardware?.gpuName ?? hardware?.cpuName ?? null;
  const [convos, setConvos] = useState<ModeConvo[]>(loadConvos);
  const [activeId, setActiveId] = useState<string>(() => loadConvos()[0]?.id ?? "");
  // Projects: named workspaces that group chats and carry shared standing instructions. "" = loose chats
  // not in any project. The editor state drives a small create/edit panel.
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [activeProjectId, setActiveProjectId] = useState<string>("");
  const [projectEditor, setProjectEditor] = useState<{ id: string | null; name: string; instructions: string } | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // Local mode needs the user's own machine (a node + hardware), so it exists only in the desktop app.
  // On the web/mobile build there is no local node, so we always use Field (answered by the network).
  const [answerMode, setAnswerMode] = useState<ConsoleAnswerMode>(() => {
    const saved = localStorage.getItem("zira.console.answerMode") as ConsoleAnswerMode | null;
    return saved === "local" && isLocalNode() ? "local" : "field";
  });
  // Compute tier — ORTHOGONAL to the Field/Local mode. It decides who does the work and how it is paid:
  //   free    = the network answers, within your free allowance (no ZIR moves)
  //   zir     = the network answers, and you pay the miners who answered (needs an unlocked wallet)
  //   machine = your own hardware answers (own-task inference), private, costs and earns no ZIR
  // It applies in BOTH modes: Field (plain chat) and Local (work inside a chosen folder).
  type ComputeTier = "free" | "zir" | "machine";
  const [computeTier, setComputeTier] = useState<ComputeTier>(() => {
    const saved = localStorage.getItem("zira.console.computeTier") as ComputeTier | null;
    return saved === "machine" && !isLocalNode() ? "free" : (saved ?? "free");
  });
  useEffect(() => { localStorage.setItem("zira.console.computeTier", computeTier); }, [computeTier]);
  const useLocalInference = computeTier === "machine";
  function setTier(t: ComputeTier) {
    setComputeTier(t);
    // Machine tier runs on your own hardware, so make sure own-task inference is on.
    if (t === "machine" && mode === "node" && mining && !mining.ownTaskInference) void setUseMachine(true);
  }
  const [coordinationProfile, setCoordinationProfile] = useState<CoordinationProfile>(() => (localStorage.getItem("zira.console.coordinationProfile") as CoordinationProfile) || "balanced");
  const { simpleMode } = useUi();
  const [attachments, setAttachments] = useState<WorkspaceAttachment[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceLocation | null>(null);
  // Local workspace agent state: a task list the agent works through, and any file writes it has proposed
  // and is waiting on the user to approve. Both live only in Local mode and are mirrored into .zira/.
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [pendingWrites, setPendingWrites] = useState<ProposedFile[]>([]);
  // Local mode, no model loaded: instead of a dead error, we offer to answer the same question through the
  // field. This holds the question waiting on that choice (keyed by the assistant message that failed),
  // so the user can pick "Use this machine" or "Ask zira" without retyping.
  const [localFieldOffer, setLocalFieldOffer] = useState<{ msgId: string; convoId: string; question: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const workspaceHandleRef = useRef<DirectoryHandleLike | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const inActiveProject = (c: ModeConvo) => (activeProjectId ? c.projectId === activeProjectId : !c.projectId);
  const visibleConvos = convos.filter((c) => (c.mode ?? "field") === answerMode && inActiveProject(c));
  const active = convos.find((c) => c.id === activeId && (c.mode ?? "field") === answerMode && inActiveProject(c));
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  // Resonators you can talk to directly: your own Resonators only.
  const [personas, setPersonas] = useState<{ id: string; name: string; systemPrompt?: string }[]>([]);
  const [personaId, setPersonaId] = useState("");
  useEffect(() => {
    if (!client) return;
    (async () => {
      try {
        const own = address ? await client.listResonators(address) : [];
        const seen = new Set<string>();
        const list: { id: string; name: string; systemPrompt?: string }[] = [];
        for (const r of own) { if (!seen.has(r.id)) { seen.add(r.id); list.push({ id: r.id, name: r.name, systemPrompt: r.systemPrompt }); } }
        // Cap the inline "Answer as" chips: a steward wallet owns hundreds of network/anchor Resonators,
        // which would flood the composer. Show a handful; "Browse Discover" reaches any specific one.
        setPersonas(list.slice(0, 8));
      } catch { /* none */ }
    })();
  }, [client, address]);

  // Deep link from Discover / Resonators: /?resonator=<id> opens a chat focused on that specific Resonator
  // (spec §4.0/§7/§8). Those pages are info-only; starting a task brings you here with the Resonator
  // pre-selected. It need not be one you own, so we fetch it to add it to the persona picker.
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // Conversation rail is a static column on large screens and a slide-over drawer on mobile.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Desktop: the conversation rail (Projects / chats) can be collapsed to reclaim width. Persisted, and
  // independent of the mobile drawer (sidebarOpen).
  const [railCollapsed, setRailCollapsed] = useState(() => { try { return localStorage.getItem("zira.console.railCollapsed") === "1"; } catch { return false; } });
  const setRail = (v: boolean) => { try { localStorage.setItem("zira.console.railCollapsed", v ? "1" : "0"); } catch { /* */ } setRailCollapsed(v); };
  useEffect(() => {
    const rid = searchParams.get("resonator");
    if (!rid || !client) return;
    setAnswerMode("field");
    setPersonaId(rid);
    (async () => {
      try {
        const r = await client.getResonator(rid);
        if (r) setPersonas((prev) => prev.some((p) => p.id === rid) ? prev : [...prev, { id: r.id, name: r.name, systemPrompt: r.systemPrompt }]);
      } catch { /* resonator fetch optional */ }
    })();
    // consume the param so a later refresh or back-nav does not re-trigger the selection
    searchParams.delete("resonator");
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, client]); // eslint-disable-line react-hooks/exhaustive-deps

  // Models are informational in chat today. Mining/model routing follows the node's field policy.
  const [fieldModels, setFieldModels] = useState<FieldModel[]>([]);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  useEffect(() => {
    if (mode !== "node") return;
    let live = true;
    const tick = async () => {
      try { const m = await NodeApi.models(); if (live) setFieldModels(m); } catch { /* */ }
      try { const p = await NodeApi.pricing(); if (live) setPricing(p); } catch { /* */ }
    };
    void tick();
    const iv = setInterval(tick, 8000);
    return () => { live = false; clearInterval(iv); };
  }, [mode]);

  // Free tier: how many free field questions remain for the connected wallet this window. Fetched on
  // mount and after each sent question. The node enforces the limit; this only surfaces it honestly.
  const [freeTier, setFreeTier] = useState<FreeTierQuota | null>(null);
  const refreshQuota = useCallback(async () => {
    if (mode !== "node" || !address) { setFreeTier(null); return; }
    try { setFreeTier(await NodeApi.queryQuota(address)); } catch { /* quota optional */ }
  }, [mode, address]);
  useEffect(() => { void refreshQuota(); }, [refreshQuota]);

  useEffect(() => { saveConvos(convos); }, [convos]);
  useEffect(() => { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects)); }, [projects]);
  useEffect(() => { localStorage.setItem("zira.console.answerMode", answerMode); }, [answerMode]);
  // A pending "ask the field instead" offer belongs to one message in one thread; drop it when the user
  // switches mode or conversation so it never attaches to an unrelated message.
  useEffect(() => { setLocalFieldOffer(null); }, [answerMode, activeId]);
  // If a local task can't run because this machine has no model, answer it from the network automatically,
  // with no extra click. Only the question is sent to the field, never local files, so workspace privacy
  // holds. Fires once the failed turn has finished streaming; askFieldFallback clears the offer so it cannot loop.
  useEffect(() => { if (localFieldOffer && !streaming) void askFieldFallback(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localFieldOffer, streaming]);
  // Switching mode or project switches to that scope's most recent thread (separate histories).
  useEffect(() => {
    const inScope = (c: ModeConvo) => (c.mode ?? "field") === answerMode && (activeProjectId ? c.projectId === activeProjectId : !c.projectId);
    const cur = convos.find((c) => c.id === activeId);
    if (cur && inScope(cur)) return;
    setActiveId(convos.find(inScope)?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerMode, activeProjectId]);
  useEffect(() => { localStorage.setItem("zira.console.coordinationProfile", coordinationProfile); }, [coordinationProfile]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [active?.messages.length, streaming]);

  // Escape closes the project editor overlay when it is open (the global handler covers the palette and
  // drawers). Bound only while the editor is open so it never swallows Escape elsewhere.
  useEffect(() => {
    if (!projectEditor) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setProjectEditor(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectEditor]);

  function newConvo(): ModeConvo {
    const c: ModeConvo = { id: "c-" + Date.now(), title: "New chat", messages: [], updatedAt: Date.now(), mode: answerMode, projectId: activeProjectId || undefined };
    setConvos((prev) => [c, ...prev]);
    setActiveId(c.id);
    return c;
  }

  function saveProjectEditor() {
    if (!projectEditor) return;
    const name = projectEditor.name.trim() || "Untitled project";
    const instructions = projectEditor.instructions;
    if (projectEditor.id) {
      setProjects((prev) => prev.map((p) => (p.id === projectEditor.id ? { ...p, name, instructions } : p)));
    } else {
      const id = "proj-" + Date.now();
      setProjects((prev) => [{ id, name, instructions, createdAt: Date.now() }, ...prev]);
      setActiveProjectId(id);
    }
    setProjectEditor(null);
  }
  function deleteProject(id: string) {
    // Chats in a deleted project become loose (move to "No project") rather than being destroyed.
    setConvos((prev) => prev.map((c) => (c.projectId === id ? { ...c, projectId: undefined } : c)));
    setProjects((prev) => prev.filter((p) => p.id !== id));
    if (activeProjectId === id) setActiveProjectId("");
    setProjectEditor(null);
  }

  function update(id: string, fn: (c: Conversation) => Conversation) {
    setConvos((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
  }

  async function attachFiles(files: FileList | null) {
    if (!files?.length) return;
    const selected = [...files].slice(0, MAX_WORKSPACE_FILES);
    const next: WorkspaceAttachment[] = [];
    let remaining = MAX_WORKSPACE_BYTES;
    let skipped = Math.max(0, files.length - selected.length);
    for (const file of selected) {
      if (remaining <= 0) break;
      if (file.size > remaining && next.length > 0) { skipped++; continue; }
      try {
        const text = await file.slice(0, Math.min(file.size, remaining)).text();
        const readable = text.replace(/\0/g, "").trimEnd();
        if (!readable) { skipped++; continue; }
        next.push({
          name: file.name,
          path: file.name,
          size: file.size,
          content: readable.slice(0, MAX_FILE_CHARS),
          truncated: readable.length > MAX_FILE_CHARS || file.size > remaining,
        });
        remaining -= Math.min(file.size, text.length);
      } catch {
        skipped++;
      }
    }
    setAttachments((prev) => {
      const byPath = new Map(prev.map((file) => [file.path, file]));
      for (const file of next) byPath.set(file.path, file);
      return [...byPath.values()].slice(0, MAX_WORKSPACE_FILES);
    });
    toast.push(next.length ? `Attached ${next.length} readable file${next.length === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}.` : "No readable text files attached.", next.length ? "teal" : "warn");
  }

  async function chooseWorkspaceFolder() {
    const picker = (window as Window & { showDirectoryPicker?: () => Promise<DirectoryHandleLike> }).showDirectoryPicker;
    if (!picker) {
      toast.push("Folder selection is not available in this environment. Attach the files you want ZIRA to use.", "warn");
      return;
    }
    try {
      const dir = await picker();
      const permission = dir.requestPermission ? await dir.requestPermission({ mode: "readwrite" }) : "denied";
      const entries: WorkspaceEntry[] = [];
      if (dir.values) {
        for await (const entry of dir.values()) {
          entries.push({ name: entry.name, kind: entry.kind });
          if (entries.length >= MAX_WORKSPACE_ENTRIES) break;
        }
      }
      entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
      workspaceHandleRef.current = dir;
      setWorkspace({ name: dir.name, entries, truncated: entries.length >= MAX_WORKSPACE_ENTRIES, writable: permission === "granted" });
      toast.push(permission === "granted"
        ? `Workspace selected with write permission: ${dir.name}`
        : `Workspace selected read-only: ${dir.name}. Allow write permission to build task files locally.`, permission === "granted" ? "teal" : "warn");
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast.push(e instanceof Error ? e.message : "Could not choose workspace folder", "danger");
    }
  }

  async function ensureDirectory(parent: DirectoryHandleLike, name: string): Promise<DirectoryHandleLike> {
    if (!parent.getDirectoryHandle) throw new Error("This environment cannot create workspace folders.");
    return parent.getDirectoryHandle(name, { create: true });
  }

  async function writeTextFile(parent: DirectoryHandleLike, name: string, content: string): Promise<void> {
    if (!parent.getFileHandle) throw new Error("This environment cannot create workspace files.");
    const file = await parent.getFileHandle(name, { create: true });
    const writable = await file.createWritable?.();
    if (!writable) throw new Error("This environment cannot write workspace files.");
    await writable.write(content);
    await writable.close();
  }

  // Write a file at a workspace-relative path, creating any intermediate folders. The path is validated to
  // stay inside the chosen folder (no "..", no absolute drive paths) so an approved write can never escape
  // the workspace the user picked. This is the only path that touches user project files, and it only runs
  // after explicit approval in the file-proposal review.
  async function writeRelativeFile(relPath: string, content: string): Promise<string> {
    const root = workspaceHandleRef.current;
    if (!root) throw new Error("No workspace folder is selected.");
    const parts = relPath.split(/[\\/]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.some((p) => p === ".." || p === "." || /^[a-zA-Z]:$/.test(p))) throw new Error(`Refusing to write outside the workspace: ${relPath}`);
    if (parts.length === 0) throw new Error("Empty file path.");
    const fileName = parts.pop()!;
    let dir = root;
    for (const segment of parts) dir = await ensureDirectory(dir, segment);
    await writeTextFile(dir, fileName, content);
    return parts.length ? `${parts.join("/")}/${fileName}` : fileName;
  }

  // Refresh the workspace root listing after files are written, so the panel reflects new top-level items.
  async function refreshWorkspaceListing(): Promise<void> {
    const root = workspaceHandleRef.current;
    if (!root?.values) return;
    const entries: WorkspaceEntry[] = [];
    try {
      for await (const entry of root.values()) {
        entries.push({ name: entry.name, kind: entry.kind });
        if (entries.length >= MAX_WORKSPACE_ENTRIES) break;
      }
    } catch { return; }
    entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
    setWorkspace((prev) => prev ? { ...prev, entries, truncated: entries.length >= MAX_WORKSPACE_ENTRIES } : prev);
  }

  // Mirror the agent session (project + task list) into .zira/ so a workspace is self-describing and the
  // task list survives a reload. Best-effort: a read-only or unavailable folder simply skips this.
  async function persistZiraSession(nextTasks: WorkspaceTask[]): Promise<void> {
    const root = workspaceHandleRef.current;
    if (!root || !workspace?.writable) return;
    try {
      const ziraDir = await ensureDirectory(root, ".zira");
      await writeTextFile(ziraDir, "workspace.json", JSON.stringify({
        project: activeProject?.name ?? null,
        instructions: activeProject?.instructions ?? "",
        updatedAt: Date.now(),
      }, null, 2));
      await writeTextFile(ziraDir, "tasks.json", JSON.stringify(nextTasks, null, 2));
    } catch { /* best effort */ }
  }

  // Update the task list and mirror it to .zira. Used when a plan is turned into tasks and as steps progress.
  function setAndPersistTasks(updater: (prev: WorkspaceTask[]) => WorkspaceTask[]) {
    setTasks((prev) => {
      const next = updater(prev);
      void persistZiraSession(next);
      return next;
    });
  }

  async function writeLocalWorkspaceResult(args: { taskId: string; question: string; fieldPrompt: string; answer: string; receipt?: AnswerReceipt; proposedFiles?: ProposedFile[] }): Promise<string | null> {
    const root = workspaceHandleRef.current;
    if (!root || !workspace?.writable) return null;
    const ziraDir = await ensureDirectory(root, ".zira");
    const taskRoot = await ensureDirectory(ziraDir, "tasks");
    const taskDir = await ensureDirectory(taskRoot, args.taskId);
    await writeTextFile(taskDir, "prompt.md", `# ZIRA Local Workspace Task\n\n${args.question}\n`);
    await writeTextFile(taskDir, "field-prompt.md", args.fieldPrompt);
    await writeTextFile(taskDir, "result.md", [
      "# ZIRA Local Workspace Result",
      "",
      args.answer,
      "",
      "## Proposed file changes",
      args.proposedFiles?.length ? args.proposedFiles.map((f) => `- ${f.path}`).join("\n") : "None.",
      "",
    ].join("\n"));
    await writeTextFile(taskDir, "context.json", JSON.stringify({
      workspace: workspace.name,
      files: attachments.map(({ name, path, size, truncated }) => ({ name, path, size, truncated })),
      proposedFiles: (args.proposedFiles ?? []).map((f) => f.path),
      createdAt: Date.now(),
    }, null, 2));
    return `.zira/tasks/${args.taskId}/result.md`;
  }

  // Poll and plan are gated independently. The poll instruction is attached ONLY when the request is a
  // freshly typed one (not a continuation from a clicked option/step), the previous turn was not itself a
  // poll, and the request actually looks ambiguous. The plan instruction is offered for fresh requests
  // (the field still decides whether to use it). Both are suppressed when continuing a poll/plan click so
  // the field neither chains polls nor re-plans mid-task.
  function questionWithWorkspaceContext(question: string, opts: { allowPoll: boolean; allowPlan: boolean }): string {
    const projectPreamble = activeProject?.instructions.trim()
      ? `Project "${activeProject.name}" — standing instructions for every task in this project:\n${activeProject.instructions.trim()}\n\n`
      : "";
    const profileText = projectPreamble + (coordinationProfile === "quick"
      ? "Coordination profile: quick. Prefer a concise answer, fewer comparison rounds, and low latency."
      : coordinationProfile === "deep"
        ? "Coordination profile: deep. Prefer stronger cross-checking, cite uncertainty, compare alternatives, and use a higher evidence standard."
        : "Coordination profile: balanced. Balance speed, evidence, and practical usefulness.")
      + (opts.allowPoll ? POLL_INSTRUCTION : "")
      + (opts.allowPlan ? PLAN_INSTRUCTION : "");
    if (attachments.length === 0 && answerMode === "field") return `${profileText}\n\nUser request:\n${question}`;
    const context = attachments.map((file) => [
      `--- ${file.path} (${file.size} bytes${file.truncated ? ", truncated" : ""}) ---`,
      file.content,
    ].join("\n")).join("\n\n");
    if (answerMode === "field") {
      return [
        "Field query with uploaded user-provided file context.",
        profileText,
        "Use the attached files as context for the answer. Do not claim direct access to the user's machine beyond this uploaded content.",
        context ? `Uploaded context:\n${context}` : "No file context was uploaded.",
        `User request:\n${question}`,
      ].join("\n\n");
    }
    const openTasks = tasks.filter((t) => t.status !== "done");
    return [
      "Local workspace task: act as an agentic coding assistant on the user's own machine. Help build, edit, plan, debug, or reason about the files in the chosen workspace folder.",
      profileText,
      "This runs on the user's own hardware (local inference), for the user's own work only. It does not serve the field.",
      workspace ? `Chosen local workspace folder: ${workspace.name}` : "No local workspace folder was chosen.",
      workspace?.entries.length ? `Visible files at workspace root:\n${workspace.entries.map((entry) => `${entry.kind === "directory" ? "dir" : "file"}: ${entry.name}`).join("\n")}${workspace.truncated ? "\n(list truncated)" : ""}` : "No workspace root listing is available.",
      openTasks.length ? `Current task list (work toward these):\n${openTasks.map((t, idx) => `${idx + 1}. [${t.status}] ${t.title}`).join("\n")}` : "No task list yet.",
      context ? `Attached file contents:\n${context}` : "No file contents were attached. Ask for specific files if more context is needed.",
      FILE_PROPOSAL_INSTRUCTION,
      `User request:\n${question}`,
    ].join("\n\n");
  }

  async function send(overrideText?: string) {
    const raw = overrideText ?? input;
    if (!raw.trim() || streaming) return;
    if (!client) {
      toast.push("Connect to a ZIRA node first.", "warn");
      return;
    }
    if (useLocalInference && mode === "node" && mining && !mining.ownTaskInference) {
      toast.push("Machine tier runs on your own hardware. Turning it on…", "neutral");
      void setUseMachine(true);
      return;
    }
    // In Local mode a folder is optional; only block when one IS chosen but is read-only.
    if (answerMode === "local" && workspaceHandleRef.current && !workspace?.writable) {
      toast.push("The selected workspace is read-only. Choose it again and allow write permission, or clear it to work without a folder.", "warn");
      return;
    }
    if (computeTier === "zir" && mode === "node" && (!hasWallet || !unlocked)) {
      toast.push("ZIR tier pays the miners who answer. Unlock a wallet first, or switch to Free.", "warn");
      return;
    }
    const question = raw.trim();
    let convo = active ?? newConvo();
    const convoId = convo.id;

    // Field/workspace mode must stay responsive even before a wallet is unlocked. Wallets only control
    // optional provider tips; autonomous coordination and signed miner answers still work.
    if (mode === "node" && (!hasWallet || !unlocked)) {
      toast.push(answerMode === "local" ? "Sending this local task to the network. Unlock a wallet later if you want to tip providers." : "Asking the network. Unlock a wallet later if you want to tip providers.", "neutral");
    }

    if (overrideText === undefined) setInput("");
    const userMsg: ChatMessage = { id: "m-" + Date.now(), role: "user", content: question, createdAt: Date.now() };
    const asstMsg: ChatMessage = { id: "a-" + Date.now(), role: "assistant", content: "", createdAt: Date.now(), streaming: true };
    update(convoId, (c) => ({
      ...c, title: c.messages.length === 0 ? question.slice(0, 40) : c.title,
      messages: [...c.messages, userMsg, asstMsg], updatedAt: Date.now(),
    }));

    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      // If a resonator persona is selected, answer in its character. The displayed question stays as
      // typed; the persona is added to what the field receives.
      // Poll/plan gating: a clicked poll option or plan step arrives via overrideText, so those turns get
      // neither. A freshly typed request may offer a plan; it may offer a poll only when the request looks
      // ambiguous AND the previous assistant turn was not itself a poll (no two polls in a row).
      const isFreshTyped = overrideText === undefined;
      const lastAssistant = [...convo.messages].reverse().find((m) => m.role === "assistant");
      const lastWasPoll = lastAssistant ? Boolean(parsePoll(lastAssistant.content)) : false;
      const allowPoll = isFreshTyped && !lastWasPoll && looksAmbiguous(question);
      // Gate the plan exactly like the poll: only offer PLAN_INSTRUCTION for a freshly typed request that
      // genuinely reads as multi-step. A trivial ask ("10+6"), a short question, or an explanation never
      // gets it, so a weak model is never nudged into a spurious "[PLAN]".
      const allowPlan = isFreshTyped && looksMultiStep(question);
      let asked = questionWithWorkspaceContext(question, { allowPoll, allowPlan });
      if (answerMode === "field" && personaId) {
        const p = personas.find((x) => x.id === personaId);
        let sys = p?.systemPrompt;
        if (sys === undefined) { try { sys = (await client!.getResonator(personaId))?.systemPrompt; } catch { /* */ } }
        if (sys) asked = `You are the resonator "${p?.name}". ${sys}\n\nAnswer this as that resonator:\n${question}`;
      }
      // Field mode goes to the network: providers answer with their own models and the asker tips the
      // contributors after the answer arrives. Local mode runs on the user's OWN hardware (local
      // inference) for the user's OWN work only: it does not touch the field, answer others, or earn.
      const history = convo.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      const onToken = (t: string) => update(convoId, (c) => ({
        ...c, messages: c.messages.map((m) => m.id === asstMsg.id ? { ...m, content: m.content + t } : m),
      }));
      const { answer, receipt } = useLocalInference && client instanceof NodeClient
        ? await client.askLocal({ question: asked, history, onToken, signal: ctrl.signal })
        : await client!.askField({ question: asked, history, asker: address ?? "zir1coordination", pay: computeTier === "zir", onToken, signal: ctrl.signal });
      // In Local mode the answer can carry a plan (turned into the task list) and file proposals (queued
      // for the user's approval). The proposals are stripped from the prose the chat shows, and the agent
      // session is journalled into .zira/tasks/<id>/.
      let finalAnswer = answer;
      if (answerMode === "local" && answer.trim() && !ctrl.signal.aborted) {
        const { files, prose } = parseFileProposals(answer);
        if (files.length) setPendingWrites((prev) => [...prev, ...files]);
        const plan = parsePlan(answer);
        if (plan && tasks.length === 0) {
          const now = Date.now();
          setAndPersistTasks(() => plan.steps.map((s, idx) => ({ id: `wt-${now}-${idx}`, title: s, status: (idx === 0 ? "active" : "pending") as WorkspaceTaskStatus, createdAt: now })));
        }
        finalAnswer = files.length ? `${prose}${prose ? "\n\n" : ""}Proposed ${files.length} file change${files.length === 1 ? "" : "s"} below. Review and approve to write them into ${workspace?.name ?? "the workspace"}.` : answer;
        try {
          const taskId = `task-${new Date().toISOString().replace(/[:.]/g, "-")}`;
          const out = await writeLocalWorkspaceResult({ taskId, question, fieldPrompt: asked, answer, receipt, proposedFiles: files });
          if (out) {
            setWorkspace((prev) => prev ? { ...prev, lastOutputPath: out } : prev);
            await persistZiraSession(tasks);
          }
        } catch (writeError) {
          toast.push(writeError instanceof Error ? writeError.message : "Could not write local workspace journal.", "danger");
        }
      }
      // Defensively strip any spurious/empty [[PLAN]] block (one with no real steps) from what gets
      // stored, so a weak model emitting a stray plan never shows the raw block as the answer. A genuine
      // multi-step plan is left intact so its interactive Plan card still renders.
      finalAnswer = stripSpuriousPlan(finalAnswer);
      // Graceful empty state: a stopped or genuinely empty answer should read as such, never as a blank
      // bubble. Aborted answers keep whatever streamed in; a never-started one gets a short, honest line.
      const settled = finalAnswer.trim()
        ? finalAnswer
        : ctrl.signal.aborted
          ? "Stopped."
          : "No answer came back this time. Try rephrasing, or ask again.";
      update(convoId, (c) => ({
        ...c, messages: c.messages.map((m) => m.id === asstMsg.id ? { ...m, content: settled, streaming: false, receipt } : m),
      }));
    } catch (e) {
      if (e instanceof FreeTierError) toast.push(e.message, "warn");
      const errMsg = e instanceof Error ? e.message : "error";
      // Local mode with no model loaded: do not dead-end. The node has no local model (or own-task
      // inference is off), so offer to answer the same question through the field instead of erroring out.
      const localNoModel = useLocalInference && /no local model|local inference for your own tasks is off|own task/i.test(errMsg);
      if (localNoModel) {
        setLocalFieldOffer({ msgId: asstMsg.id, convoId, question });
        update(convoId, (c) => ({
          ...c, messages: c.messages.map((m) => m.id === asstMsg.id ? { ...m, content: "No model on this machine yet. You don't need one. Asking the network for you...", streaming: false } : m),
        }));
      } else {
        update(convoId, (c) => ({
          ...c, messages: c.messages.map((m) => m.id === asstMsg.id ? { ...m, content: "Could not get an answer: " + errMsg, streaming: false } : m),
        }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      void refreshQuota();
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  // Local mode fallback: the user chose "Ask zira" after a local answer could not run (no model loaded).
  // Route the same question to the field, replacing the offer message in place so the thread stays clean.
  async function askFieldFallback() {
    const offer = localFieldOffer;
    if (!offer || !client || streaming) return;
    setLocalFieldOffer(null);
    // Mark the failed bubble as superseded and stream the field answer into it.
    update(offer.convoId, (c) => ({
      ...c, messages: c.messages.map((m) => m.id === offer.msgId ? { ...m, content: "", streaming: true, receipt: undefined } : m),
    }));
    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const convo = convos.find((c) => c.id === offer.convoId);
      const history = (convo?.messages ?? []).filter((m) => m.role !== "system" && m.id !== offer.msgId).map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      const onToken = (t: string) => update(offer.convoId, (c) => ({
        ...c, messages: c.messages.map((m) => m.id === offer.msgId ? { ...m, content: m.content + t } : m),
      }));
      const { answer, receipt } = await client.askField({ question: offer.question, history, asker: address ?? "zir1coordination", onToken, signal: ctrl.signal });
      const settled = stripSpuriousPlan(answer).trim() || (ctrl.signal.aborted ? "Stopped." : "No answer came back this time. Try rephrasing, or ask again.");
      update(offer.convoId, (c) => ({
        ...c, messages: c.messages.map((m) => m.id === offer.msgId ? { ...m, content: settled, streaming: false, receipt } : m),
      }));
    } catch (e) {
      if (e instanceof FreeTierError) toast.push(e.message, "warn");
      update(offer.convoId, (c) => ({
        ...c, messages: c.messages.map((m) => m.id === offer.msgId ? { ...m, content: "Could not get an answer from the field: " + (e instanceof Error ? e.message : "error"), streaming: false } : m),
      }));
    } finally {
      setStreaming(false);
      abortRef.current = null;
      void refreshQuota();
    }
  }

  // Permissions model: approve a single proposed write (or all of them). This is the only place project
  // files are written, and only on explicit user action. After writing, the root listing refreshes.
  async function approveWrite(file: ProposedFile) {
    if (!workspace?.writable) { toast.push("The workspace is read-only. Re-select it and allow write permission.", "warn"); return; }
    try {
      const written = await writeRelativeFile(file.path, file.content);
      setPendingWrites((prev) => prev.filter((f) => f !== file));
      await refreshWorkspaceListing();
      toast.push(`Wrote ${written}`, "teal");
    } catch (e) {
      toast.push(e instanceof Error ? e.message : `Could not write ${file.path}`, "danger");
    }
  }
  async function approveAllWrites() {
    if (!pendingWrites.length) return;
    if (!workspace?.writable) { toast.push("The workspace is read-only. Re-select it and allow write permission.", "warn"); return; }
    const queue = [...pendingWrites];
    let ok = 0;
    for (const file of queue) {
      try { await writeRelativeFile(file.path, file.content); setPendingWrites((prev) => prev.filter((f) => f !== file)); ok++; }
      catch (e) { toast.push(e instanceof Error ? e.message : `Could not write ${file.path}`, "danger"); }
    }
    await refreshWorkspaceListing();
    if (ok) toast.push(`Wrote ${ok} file${ok === 1 ? "" : "s"} into ${workspace.name}.`, "teal");
  }
  // Dynamic ZIR estimate for a field question. The cost is not fixed: it scales with how broadly the
  // field coordinates (the profile) and with live demand and supply (the node's adaptive price). This is
  // an estimate shown BEFORE sending; the ACTUAL cost comes back on the answer receipt (receipt.costUZIR)
  // and is shown there. No fabricated numbers: the base is whatever the node's /pricing returns.
  const breadthMultiplier = coordinationProfile === "quick" ? 1 : coordinationProfile === "deep" ? 3 : 1.8;
  const estimateUZIR = Math.round(((pricing?.queryUZIR ?? PROTOCOL.QUERY_PRICE_UZIR) + PROTOCOL.BASE_FEE_UZIR) * breadthMultiplier);
  // Whether this next question is covered by the free allowance (contributing, or remaining > 0), so the
  // estimate reads "free" vs a ZIR amount honestly.
  const nextIsFree = Boolean(freeTier && (freeTier.contributor || freeTier.unlimited || freeTier.remaining > 0)) || Boolean(mining?.enabled);

  function toggleTaskDone(id: string) {
    setAndPersistTasks((prev) => {
      const flipped = prev.map((t) => t.id === id ? { ...t, status: (t.status === "done" ? "pending" : "done") as WorkspaceTaskStatus } : t);
      // Promote the first remaining open task to active so the list always shows what is next.
      const firstOpen = flipped.find((t) => t.status !== "done");
      return flipped.map((t) => t.status === "done" ? t : { ...t, status: t.id === firstOpen?.id ? "active" : "pending" });
    });
  }

  return (
    <div className="relative flex h-full">
      {/* mobile backdrop when the conversation drawer is open */}
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} aria-hidden />}
      {/* conversation rail: a slide-over drawer on mobile, a static rail on large screens */}
      <div className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-hairline bg-surface transition-transform duration-200 lg:static lg:z-auto lg:w-60 lg:translate-x-0 lg:bg-surface/40 ${sidebarOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full lg:shadow-none"} ${railCollapsed ? "lg:hidden" : ""}`}>
        <div className="border-b border-hairline px-3 py-2.5">
          <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-faint">
            <span>Project</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setProjectEditor({ id: null, name: "", instructions: "" })} title="New project" className="text-faint transition-colors hover:text-text"><Plus size={13} /></button>
              <button onClick={() => setRail(true)} title="Hide panel" aria-label="Hide chats panel" className="hidden text-faint transition-colors hover:text-text lg:inline-flex"><PanelLeftClose size={13} /></button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            <button onClick={() => setActiveProjectId("")} className={`rounded-md px-2 py-1 text-xs transition-colors ${!activeProjectId ? "bg-elevated text-text" : "text-muted hover:text-text"}`}>No project</button>
            {projects.map((p) => (
              <button key={p.id} onClick={() => setActiveProjectId(p.id)} title={p.instructions || p.name}
                className={`max-w-[8rem] truncate rounded-md px-2 py-1 text-xs transition-colors ${activeProjectId === p.id ? "bg-[color-mix(in_srgb,var(--indigo)_18%,transparent)] text-[var(--indigo)]" : "text-muted hover:text-text"}`}>{p.name}</button>
            ))}
          </div>
          {activeProject && (
            <div className="mt-1.5 flex items-center gap-3 text-[10px] text-faint">
              <button onClick={() => setProjectEditor({ id: activeProject.id, name: activeProject.name, instructions: activeProject.instructions })} className="underline transition-colors hover:text-text">edit instructions</button>
              <button onClick={() => deleteProject(activeProject.id)} className="underline transition-colors hover:text-[var(--danger)]">delete</button>
            </div>
          )}
        </div>
        <div className="flex gap-2 p-3">
          <Button variant="secondary" className="flex-1" onClick={() => { newConvo(); setSidebarOpen(false); }}><Plus size={15} /> New chat</Button>
          {active && active.messages.length > 0 && (
            <Button variant="ghost" title="Export this chat as Markdown" onClick={() => exportConvo(active)}><Download size={15} /></Button>
          )}
        </div>
        <div className="flex items-center justify-between px-3 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-faint">
          <span className="truncate">{activeProject ? `${activeProject.name} · ${answerMode}` : answerMode === "field" ? "Field chats" : "Local chats"}</span>
          {visibleConvos.length > 0 && <span className="mono">{visibleConvos.length}</span>}
        </div>
        <div className="flex-1 overflow-auto px-2 pb-2">
          {visibleConvos.length === 0 ? (
            <p className="px-2 py-3 text-xs leading-relaxed text-faint">{activeProject ? `No ${answerMode} chats in “${activeProject.name}” yet. New chats here join this project and use its instructions.` : `No ${answerMode === "field" ? "field" : "local"} chats yet. Field and Local keep separate histories.`}</p>
          ) : visibleConvos.map((c) => (
            <div key={c.id} onClick={() => { setActiveId(c.id); setSidebarOpen(false); }}
              className={`group relative flex items-center justify-between rounded-lg py-2 pl-3 pr-2 text-sm cursor-pointer transition-colors ${c.id === activeId ? "bg-elevated text-text" : "text-muted hover:bg-elevated/60 hover:text-text"}`}>
              {c.id === activeId && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-[var(--teal)]" aria-hidden />}
              <span className="truncate">{c.title}</span>
              <button onClick={(e) => { e.stopPropagation(); setConvos((p) => p.filter((x) => x.id !== c.id)); }}
                title="Delete chat" className="opacity-0 group-hover:opacity-100 text-faint hover:text-[var(--danger)]"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      </div>

      {projectEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setProjectEditor(null)}>
          <div className="w-full max-w-md rounded-xl border border-hairline bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-sm font-semibold text-text">{projectEditor.id ? "Edit project" : "New project"}</h3>
            <label className="mb-1 block text-xs text-faint">Name</label>
            <input value={projectEditor.name} onChange={(e) => setProjectEditor({ ...projectEditor, name: e.target.value })} placeholder="e.g. Trading bot, Research notes" autoFocus
              className="mb-3 w-full rounded-md border border-hairline bg-base px-3 py-2 text-sm text-text outline-none focus:border-[var(--indigo)]" />
            <label className="mb-1 block text-xs text-faint">Standing instructions <span className="text-faint">(added to every task in this project)</span></label>
            <textarea value={projectEditor.instructions} onChange={(e) => setProjectEditor({ ...projectEditor, instructions: e.target.value })} rows={5} placeholder="e.g. You are helping build a Rust trading bot. Prefer idiomatic, well-tested code and explain trade-offs."
              className="mb-3 w-full resize-none rounded-md border border-hairline bg-base px-3 py-2 text-sm text-text outline-none focus:border-[var(--indigo)]" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setProjectEditor(null)}>Cancel</Button>
              <Button variant="primary" onClick={saveProjectEditor}>{projectEditor.id ? "Save" : "Create project"}</Button>
            </div>
          </div>
        </div>
      )}

      {/* chat */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* mode is chosen here, above the chat. Field and Local workspace are separate modes. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline bg-surface/40 px-4 py-3 backdrop-blur-sm">
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={() => setSidebarOpen(true)} title="Chats" aria-label="Open chats" className="shrink-0 rounded-md border border-hairline p-1.5 text-muted transition-colors hover:text-text lg:hidden"><Menu size={16} /></button>
            {railCollapsed && <button onClick={() => setRail(false)} title="Show chats" aria-label="Show chats panel" className="hidden shrink-0 rounded-md border border-hairline p-1.5 text-muted transition-colors hover:text-text lg:inline-flex"><PanelLeftOpen size={16} /></button>}
            <button onClick={() => { newConvo(); setSidebarOpen(false); }} title="New chat" aria-label="New chat" className="shrink-0 rounded-md border border-hairline p-1.5 text-muted transition-colors hover:text-text lg:hidden"><MessageSquarePlus size={16} /></button>
            {/* Mode: Field (plain chat) vs Local (work inside a folder). */}
            <div role="tablist" aria-label="Mode" className="relative inline-flex shrink-0 rounded-lg border border-hairline bg-base/50 p-1">
              <button role="tab" aria-selected={answerMode === "field"} onClick={() => setAnswerMode("field")} title="Ask the field. A plain conversation." className={`relative z-[1] inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${answerMode === "field" ? "bg-[color-mix(in_srgb,var(--teal)_15%,transparent)] text-[var(--teal)] shadow-[0_1px_0_color-mix(in_srgb,var(--teal)_22%,transparent)]" : "text-faint hover:text-text"}`}>
                <Sparkles size={13} /> Field
              </button>
              {isLocalNode() && (
                <button role="tab" aria-selected={answerMode === "local"} onClick={() => setAnswerMode("local")} title="Work inside a folder on your computer: build, edit, plan, or debug." className={`relative z-[1] inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${answerMode === "local" ? "bg-[color-mix(in_srgb,var(--indigo)_15%,transparent)] text-[var(--indigo)] shadow-[0_1px_0_color-mix(in_srgb,var(--indigo)_22%,transparent)]" : "text-faint hover:text-text"}`}>
                  <FolderOpen size={13} /> Local
                </button>
              )}
            </div>
            {/* Compute tier: who does the work and how it's paid. Applies in BOTH modes. */}
            <div role="tablist" aria-label="Compute and payment" className="relative inline-flex shrink-0 rounded-lg border border-hairline bg-base/50 p-1">
              <button role="tab" aria-selected={computeTier === "free"} onClick={() => setTier("free")} title="The network answers, within your free allowance." className={`relative z-[1] inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${computeTier === "free" ? "bg-[color-mix(in_srgb,var(--teal)_15%,transparent)] text-[var(--teal)] shadow-[0_1px_0_color-mix(in_srgb,var(--teal)_22%,transparent)]" : "text-faint hover:text-text"}`}>
                Free
              </button>
              <button role="tab" aria-selected={computeTier === "zir"} onClick={() => setTier("zir")} title="The network answers; you pay the miners who answer in ZIR." className={`relative z-[1] inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${computeTier === "zir" ? "bg-[color-mix(in_srgb,var(--teal)_15%,transparent)] text-[var(--teal)] shadow-[0_1px_0_color-mix(in_srgb,var(--teal)_22%,transparent)]" : "text-faint hover:text-text"}`}>
                <Coins size={12} /> ZIR
              </button>
              {isLocalNode() && (
                <button role="tab" aria-selected={computeTier === "machine"} onClick={() => setTier("machine")} title="Your own computer answers. Private, costs and earns no ZIR." className={`relative z-[1] inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${computeTier === "machine" ? "bg-[color-mix(in_srgb,var(--indigo)_15%,transparent)] text-[var(--indigo)] shadow-[0_1px_0_color-mix(in_srgb,var(--indigo)_22%,transparent)]" : "text-faint hover:text-text"}`}>
                  <Cpu size={12} /> Machine
                </button>
              )}
            </div>
            <span className="hidden min-w-0 max-w-xl truncate text-xs text-faint xl:inline">{(answerMode === "local" ? "Work in a folder on your computer. " : "") + (computeTier === "free" ? "The network answers, within your free allowance. Signed receipt included." : computeTier === "zir" ? "The network answers; you pay the miners who answer in ZIR (unlock a wallet first)." : "Your own computer answers. Private, costs and earns no ZIR (that is Mining, a separate switch).")}</span>
          </div>
          {answerMode === "field" && (
            <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
              {fieldModels.length > 0 && <Badge tone="indigo" className="text-[10px]"><span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--indigo)]" />{fieldModels.length} model{fieldModels.length === 1 ? "" : "s"} on field</Badge>}
              <Select value={coordinationProfile} onChange={(e) => setCoordinationProfile(e.target.value as CoordinationProfile)} className="w-auto py-1.5 text-xs" title="How hard the network works on your question: quick, balanced, or deep evidence.">
                <option value="quick">Quick</option>
                <option value="balanced">Balanced</option>
                <option value="deep">Deep evidence</option>
              </Select>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-auto p-4">
          {!active || active.messages.length === 0 ? (
            <EmptyHero mode={answerMode} onPick={setInput} />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-6 py-2">
              {active.messages.map((m) => (
                <div key={m.id} className="flex flex-col gap-3">
                  <Message m={m} busy={streaming} onPick={(opt) => void send(opt)} />
                  {localFieldOffer?.msgId === m.id && (
                    <div className="max-w-[92%] rounded-2xl border border-[color-mix(in_srgb,var(--teal)_30%,transparent)] bg-[color-mix(in_srgb,var(--teal)_7%,transparent)] px-4 py-3">
                      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-[var(--teal)]"><Sparkles size={13} /> Two ways to answer this</div>
                      <p className="mb-2.5 text-sm text-muted">Local couldn&apos;t run because this machine has no model loaded. Use your own machine for a private answer, or ask the network and let it answer for you.</p>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="primary" disabled={streaming} onClick={() => void askFieldFallback()}><Sparkles size={14} /> Ask the network</Button>
                        <Button variant="secondary" disabled={hwBusy || streaming} onClick={() => void setUseMachine(true)}>Use my machine (private)</Button>
                        <Button variant="ghost" onClick={() => setLocalFieldOffer(null)}>Dismiss</Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* composer */}
        <div className="sticky bottom-0 border-t border-hairline bg-surface/60 p-3 backdrop-blur-xl sm:p-4">
          <div className="mx-auto max-w-3xl">
            {answerMode === "field" && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-faint">Answer with</span>
                <button onClick={() => setPersonaId("")}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 transition-colors ${personaId === "" ? "border-[var(--teal)] bg-[color-mix(in_srgb,var(--teal)_12%,transparent)] text-[var(--teal)]" : "border-hairline text-muted hover:text-text"}`}>
                  <Sparkles size={11} /> The network
                </button>
                {personaId !== "" && (
                  <span className="inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-[var(--indigo)] bg-[color-mix(in_srgb,var(--indigo)_12%,transparent)] px-2.5 py-1 text-[var(--indigo)]" title="Selected on Discover. Tap The network to clear.">
                    <Bot size={11} /> <span className="truncate">{personas.find((p) => p.id === personaId)?.name ?? "AI worker"}</span>
                  </span>
                )}
                <button onClick={() => navigate("/marketplace")} title="Choose a Resonator in Discover"
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-hairline px-2.5 py-1 text-faint transition-colors hover:border-[var(--teal)] hover:text-[var(--teal)]">
                  <Compass size={11} /> Browse Discover <ArrowRight size={10} />
                </button>
              </div>
            )}
            {answerMode === "local" && tasks.length > 0 && (
              <TaskListPanel tasks={tasks} onToggle={toggleTaskDone} onClear={() => setAndPersistTasks(() => [])} />
            )}
            {answerMode === "local" && pendingWrites.length > 0 && (
              <PendingWritesPanel
                writes={pendingWrites}
                workspaceName={workspace?.name ?? null}
                writable={Boolean(workspace?.writable)}
                onApprove={(f) => void approveWrite(f)}
                onApproveAll={() => void approveAllWrites()}
                onDiscard={(f) => setPendingWrites((prev) => prev.filter((x) => x !== f))}
                onDiscardAll={() => setPendingWrites([])}
              />
            )}
            {(attachments.length > 0 || (answerMode === "local" && workspace)) && (
              <WorkspaceContextPanel
                mode={answerMode}
                files={attachments}
                workspace={workspace}
                onRemove={(path) => setAttachments((prev) => {
                  return prev.filter((file) => file.path !== path);
                })}
                onClearFiles={() => setAttachments([])}
                onClearWorkspace={() => { workspaceHandleRef.current = null; setWorkspace(null); setTasks([]); setPendingWrites([]); }}
              />
            )}
            <div className="field-surface flex items-end gap-2 rounded-2xl border border-hairline-strong p-2 shadow-[var(--shadow-1)] transition-all focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent-ring)]">
              <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ""; }} />
              <div className="flex flex-col gap-1">
                <Button variant="ghost" title={answerMode === "field" ? "Attach files to this field query" : "Choose local files as workspace context"} onClick={() => fileRef.current?.click()}><Upload size={15} /></Button>
                {answerMode === "local" && <Button variant="ghost" title="Choose the local workspace folder. This does not upload the folder." onClick={chooseWorkspaceFolder}><FolderOpen size={15} /></Button>}
              </div>
              <textarea
                value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter always sends; plain Enter sends (Shift+Enter inserts a newline).
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); return; }
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
                }}
                placeholder={answerMode === "local" ? "Pick a folder, attach any files you want it to see, then ask ZIRA to build, edit, plan, or debug." : personaId ? "Ask this AI worker. Attach files if useful. Enter to send." : "Ask the network anything. Attach files if useful. Enter to send, Shift+Enter for a new line."}
                rows={1} className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-text placeholder:text-faint outline-none"
              />
              {streaming
                ? <Button variant="secondary" onClick={stop}><Square size={15} /> Stop</Button>
                : <Button variant="primary" onClick={() => void send()} disabled={!input.trim()} title="Send (Enter)"><Send size={15} /></Button>}
            </div>
            <div className="mt-2 flex items-start justify-between gap-3 px-1 text-[11px] leading-relaxed text-faint">
              {computeTier === "machine" ? (
                <span>{answerMode === "local" ? "Local mode works inside a folder on your computer: it plans tasks, proposes file edits you approve before they are saved, and keeps its session in " : "Your own computer answers privately. "}{answerMode === "local" && <span className="mono text-muted">.zira/</span>}{answerMode === "local" ? " inside that folder. Your machine does the work, costs and earns no ZIR." : "It costs and earns no ZIR."}</span>
              ) : (
                <span>
                  {answerMode === "local" && <>This runs in your folder; only the question and any files you attach are sent, never the whole folder. </>}
                  {computeTier === "free" && nextIsFree ? (
                    <>This question is <span className="text-[var(--teal)]">free</span> right now. Past the free allowance, asking more of the network costs about <span className="mono text-muted" title="An estimate. The price changes with how broadly you ask (the profile) and live demand. The exact amount comes back on the answer receipt.">{formatZir(estimateUZIR)} ZIR</span> per question ({coordinationProfile}).</>
                  ) : (
                    <>About <span className="mono text-muted" title="An estimate. The price changes with how broadly you ask (the profile) and live demand. The exact amount comes back on the answer receipt.">~{formatZir(estimateUZIR)} ZIR</span> for this question{simpleMode ? "" : ` (${coordinationProfile})`}. You see the exact cost on the receipt once the answer arrives.</>
                  )}
                </span>
              )}
              {computeTier !== "machine" && pricing && <span className="mono shrink-0 whitespace-nowrap text-faint" title="The price moves with live demand and how many machines are online across the network.">{pricing.providersOnline} online · {pricing.openQueries} asking</span>}
            </div>
            {mode === "node" && isLocalNode() && computeTier === "machine" && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1 text-xs text-muted">
                <span className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-medium ${mining?.ownTaskInference ? "border-[color-mix(in_srgb,var(--violet)_40%,transparent)] bg-[color-mix(in_srgb,var(--violet)_12%,transparent)] text-[var(--violet)]" : "border-hairline text-muted"}`}>
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${mining?.ownTaskInference ? "bg-[var(--violet)]" : "bg-faint"}`} />
                  {hwBusy ? "Starting your machine…" : mining?.ownTaskInference ? "Your machine is answering" : "Preparing your machine…"}
                </span>
                {mining?.ownTaskInference && hwSummary && <span className="text-faint">On <span className="text-text">{hwSummary}</span>. Private, earns no ZIR.</span>}
                {mining?.ownTaskInference && <button onClick={rescanHardware} disabled={hwBusy} className="underline hover:text-text disabled:opacity-50">rescan</button>}
              </div>
            )}
            {computeTier === "free" && freeTier && (
              <div className="mt-1.5 flex items-center gap-1.5 px-1 text-xs text-muted">
                {(freeTier.contributor || freeTier.unlimited) ? (
                  <>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--teal)]" />
                    <span>Free questions: <span className="text-text">unlimited</span> while your machine helps run the network.</span>
                  </>
                ) : freeTier.freeTierEnded ? (
                  <>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--warn)]" />
                    <span>The free tier has ended. Add ZIR to your wallet to keep asking, or contribute your own machine to ask for free.</span>
                  </>
                ) : freeTier.remaining > 0 ? (
                  <>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--teal)]" />
                    <span>Free questions: <span className="mono text-text">{freeTier.remaining}</span> of <span className="mono">{freeTier.limit}</span> left</span>
                  </>
                ) : (
                  <>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--warn)]" />
                    <span>Free questions reset in <span className="mono">{Math.ceil(freeTier.resetMs / 60000)}m</span>. Add ZIR to your wallet to keep asking now.</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// A welcoming first-run state. Mode-aware: it explains in plain language what Field and Local do,
// then invites the first question with a few tappable examples that fill the composer.
function EmptyHero({ mode, onPick }: { mode: ConsoleAnswerMode; onPick: (v: string) => void }) {
  const isField = mode === "field";
  const examples = isField
    ? ["Compare two approaches and recommend one with reasons.", "Explain how ZIRA agrees on an answer, in plain words.", "Draft a clear answer I can send to a non-technical reader."]
    : ["Draft a README for this project.", "Find and explain the bug in this function.", "Plan the next three commits for this folder."];
  const steps = isField
    ? [
        { k: "Coordinate", v: "Many independent providers answer the same question." },
        { k: "Converge", v: "Their answers settle on one result, weighted by earned trust." },
        { k: "Verify", v: "A receipt shows who answered, their trust score, and the cost." },
      ]
    : [
        { k: "Choose", v: "Pick a project folder on this machine. It stays local." },
        { k: "Propose", v: "ZIRA plans tasks and proposes file edits in that folder." },
        { k: "Approve", v: "You review and approve each write before it is saved." },
      ];
  return (
    <div className="fade-in-up mx-auto flex max-w-2xl flex-col items-center justify-center gap-5 py-12 text-center sm:py-16">
      <HexField size={104} />
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-xl font-semibold tracking-tight">
          {isField ? <>Ask the <span className="gradient-text">network</span></> : <>Your <span className="gradient-text">private workspace</span></>}
        </h2>
        <p className="max-w-md text-sm leading-relaxed text-muted">
          {isField
            ? "Ask the network. Independent providers answer, ZIRA settles on the best result by earned trust, and every answer comes with proof you can open and check."
            : "A private workspace on your own machine. Pick a folder and ZIRA works through the job, proposing file edits you approve before anything is saved. Only the files you choose to attach ever leave your machine."}
        </p>
      </div>
      <div className="grid w-full max-w-lg gap-2 text-left text-xs sm:grid-cols-3">
        {steps.map((s) => (
          <Card key={s.k} className="p-3">
            <div className="font-medium text-text">{s.k}</div>
            <div className="mt-1 text-faint">{s.v}</div>
          </Card>
        ))}
      </div>
      {isField && <ThreeWaysToAsk />}
      <div className="flex flex-col items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-faint">Try asking</span>
        <div className="flex flex-wrap justify-center gap-2">
          {examples.map((ex) => (
            <button key={ex} onClick={() => onPick(ex)} className="rounded-full border border-hairline bg-surface/60 px-3 py-1.5 text-xs text-muted transition-colors hover:border-hairline-strong hover:text-text">{ex}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Three ways to use ZIRA, presented crisply so the distinction reads at a glance: ask free within the
// allowance, pay ZIR for broader coordinated answers, or run it privately on your own machine. The cost
// of the paid path is dynamic on purpose, which the card states plainly without inventing a number.
function ThreeWaysToAsk() {
  const ways = [
    {
      k: "Ask free",
      tone: "var(--teal)",
      v: "For the network's first year, the contributing community covers a free allowance of everyday questions — no ZIR and no machine of your own needed. After that first year, ask with ZIR or run your own machine. Contributing your machine keeps your questions free, with no limit, for good.",
    },
    {
      k: "Pay ZIR for more",
      tone: "var(--indigo)",
      v: "Spend ZIR to put more of the network on a harder question, so more providers work on it. The price changes with how broadly you ask and how hard the task is. You see an estimate before you send and the exact amount on the receipt.",
    },
    {
      k: "Use your machine",
      tone: "var(--violet)",
      v: "Run it privately on your own computer in Local mode. Nothing leaves your machine, and it costs no ZIR.",
    },
  ];
  return (
    <div className="w-full max-w-lg text-left">
      <div className="mb-2 text-center text-[11px] uppercase tracking-wider text-faint">Three ways to use ZIRA</div>
      <div className="grid gap-2 sm:grid-cols-3">
        {ways.map((w) => (
          <Card key={w.k} className="p-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-text">
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: w.tone }} />
              {w.k}
            </div>
            <div className="mt-1 text-[11px] leading-relaxed text-faint">{w.v}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// The local workspace task list: what the agent is working through. Steps come from a plan the field
// proposed; the user can check them off (which advances the next one to "active") or clear the list.
// Mirrored into .zira/tasks.json so it survives a reload.
function TaskListPanel({ tasks, onToggle, onClear }: { tasks: WorkspaceTask[]; onToggle: (id: string) => void; onClear: () => void }) {
  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <Card className="mb-2 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-text"><ListChecks size={14} className="text-[var(--teal)]" /> Workspace tasks</div>
        <div className="flex items-center gap-2 text-[11px] text-faint">
          <span className="mono">{done}/{tasks.length} done</span>
          <button onClick={onClear} className="underline transition-colors hover:text-[var(--danger)]">clear</button>
        </div>
      </div>
      <ol className="space-y-1">
        {tasks.map((t) => (
          <li key={t.id}>
            <button onClick={() => onToggle(t.id)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-elevated/60">
              <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] ${t.status === "done" ? "border-[var(--teal)] bg-[color-mix(in_srgb,var(--teal)_18%,transparent)] text-[var(--teal)]" : t.status === "active" ? "border-[var(--indigo)] text-[var(--indigo)]" : "border-hairline text-faint"}`}>
                {t.status === "done" ? <Check size={11} /> : null}
              </span>
              <span className={`min-w-0 ${t.status === "done" ? "text-faint line-through" : "text-text"}`}>{t.title}</span>
              {t.status === "active" && <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-[var(--indigo)]">next</span>}
            </button>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// The permissions surface: file writes the agent proposed, each shown with its full target path and
// contents, awaiting the user's approval. Nothing is written until the user approves it here. This is the
// workspace equivalent of an agent asking before it touches your disk.
function PendingWritesPanel({ writes, workspaceName, writable, onApprove, onApproveAll, onDiscard, onDiscardAll }: {
  writes: ProposedFile[];
  workspaceName: string | null;
  writable: boolean;
  onApprove: (f: ProposedFile) => void;
  onApproveAll: () => void;
  onDiscard: (f: ProposedFile) => void;
  onDiscardAll: () => void;
}) {
  const [open, setOpen] = useState<string | null>(writes[0]?.path ?? null);
  return (
    <Card className="mb-2 border-[color-mix(in_srgb,var(--indigo)_30%,transparent)] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-text"><FilePlus size={14} className="text-[var(--indigo)]" /> Proposed file changes</div>
          <div className="mt-0.5 text-[11px] text-faint">{writes.length} file{writes.length === 1 ? "" : "s"} waiting for your approval{workspaceName ? <> into <span className="mono">{workspaceName}</span></> : null}. Nothing is written until you approve.</div>
        </div>
        <div className="flex gap-1">
          <Button variant="primary" className="px-2 py-1 text-xs" onClick={onApproveAll} disabled={!writable}><Check size={13} /> Approve all</Button>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onDiscardAll}><X size={13} /> Discard all</Button>
        </div>
      </div>
      {!writable && <div className="mb-2 rounded-lg border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] p-2 text-[11px] text-muted">The workspace is read-only. Re-select the folder and allow write permission to apply these.</div>}
      <div className="flex flex-col gap-1.5">
        {writes.map((f, idx) => (
          <div key={`${f.path}-${idx}`} className="rounded-lg border border-hairline bg-base/60">
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <button onClick={() => setOpen((o) => o === f.path ? null : f.path)} className="flex min-w-0 items-center gap-1.5 text-left text-xs text-text">
                {open === f.path ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                <span className="mono truncate">{f.path}</span>
                <span className="shrink-0 text-[10px] text-faint">{f.content.split("\n").length} lines</span>
              </button>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => onApprove(f)} disabled={!writable} title="Approve this write" className="rounded-md p-1 text-[var(--teal)] transition-colors hover:bg-[color-mix(in_srgb,var(--teal)_12%,transparent)] disabled:opacity-40"><Check size={14} /></button>
                <button onClick={() => onDiscard(f)} title="Discard this proposal" className="rounded-md p-1 text-faint transition-colors hover:text-[var(--danger)]"><X size={14} /></button>
              </div>
            </div>
            {open === f.path && (
              <pre className="max-h-48 overflow-auto border-t border-hairline px-3 py-2 text-[11px] leading-relaxed"><code className="mono">{f.content}</code></pre>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function WorkspaceContextPanel({ mode, files, workspace, onRemove, onClearFiles, onClearWorkspace }: {
  mode: ConsoleAnswerMode;
  files: WorkspaceAttachment[];
  workspace: WorkspaceLocation | null;
  onRemove: (path: string) => void;
  onClearFiles: () => void;
  onClearWorkspace: () => void;
}) {
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const truncated = files.filter((file) => file.truncated).length;
  const title = mode === "field" ? "Attached field context" : "Local workspace context";
  const hint = mode === "field"
    ? "These files will be included in the field query."
    : "The folder stays local; only attached files are sent as content. ZIRA writes task results into `.zira/tasks` when permission is granted.";
  return (
    <Card className="mb-2 p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-text">
            {mode === "local" ? <FolderOpen size={14} className="text-[var(--indigo)]" /> : <FileText size={14} className="text-[var(--indigo)]" />}
            {title}
          </div>
          <div className="mt-0.5 text-[11px] text-faint">
            {mode === "local" && workspace ? <><span className="mono">{workspace.name}</span> · {workspace.writable ? "writable" : "read-only"} · </> : null}
            {files.length} attached file{files.length === 1 ? "" : "s"} · {formatBytes(bytes)}
            {truncated > 0 ? ` · ${truncated} truncated` : ""}
          </div>
          <div className="mt-0.5 text-[11px] text-muted">{hint}</div>
        </div>
        <div className="flex gap-1">
          {files.length > 0 && <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onClearFiles}><X size={13} /> Clear files</Button>}
          {mode === "local" && workspace && <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onClearWorkspace}><X size={13} /> Clear folder</Button>}
        </div>
      </div>
      {mode === "local" && workspace && (
        <div className="mb-2 rounded-lg border border-hairline bg-base/60 p-2">
          <div className="mb-1 flex items-center justify-between text-[11px] text-faint">
            <span>Workspace root listing</span>
            <span>{workspace.entries.length}{workspace.truncated ? "+" : ""} item{workspace.entries.length === 1 ? "" : "s"}</span>
          </div>
          {workspace.lastOutputPath && <div className="mb-1 text-[11px] text-[var(--teal)]">Last local build output: <span className="mono">{workspace.lastOutputPath}</span></div>}
          {workspace.entries.length ? (
            <div className="grid max-h-24 gap-1 overflow-auto text-[11px] sm:grid-cols-2">
              {workspace.entries.map((entry) => (
                <div key={`${entry.kind}:${entry.name}`} className="min-w-0 truncate text-muted">
                  {entry.kind === "directory" ? "dir" : "file"}: {entry.name}
                </div>
              ))}
            </div>
          ) : <div className="text-[11px] text-faint">No readable root listing was returned.</div>}
        </div>
      )}
      {files.length > 0 && (
        <div className="max-h-32 overflow-auto rounded-lg border border-hairline bg-base/60">
          {files.map((file) => (
            <div key={file.path} className="flex items-center justify-between gap-2 border-b border-hairline px-2 py-1.5 last:border-b-0">
              <div className="min-w-0">
                <div className="truncate text-xs text-text">{file.path}</div>
                <div className="text-[10px] text-faint">{formatBytes(file.size)}{file.truncated ? " · truncated for context window" : ""}</div>
              </div>
              <button className="shrink-0 text-faint hover:text-[var(--danger)]" title="Remove file" onClick={() => onRemove(file.path)}><X size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function CopyButton({ text, label = "copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className={`inline-flex items-center gap-1 transition-colors hover:text-text ${className}`}
    >
      {copied ? <><CheckCircle2 size={11} /> copied</> : <><Copy size={11} /> {label}</>}
    </button>
  );
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-hairline bg-base">
      <div className="flex items-center justify-between border-b border-hairline px-3 py-1 text-[10px] text-faint">
        <span className="mono">{lang || "code"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-xs leading-relaxed"><code className="mono">{code}</code></pre>
    </div>
  );
}

// Inline markdown for a single line: **bold**, `code`, and [text](url) links. Kept tiny and
// dependency-free. Anything not matched is rendered as plain text, so unusual input degrades gracefully.
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0, i = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) out.push(<strong key={`${keyBase}-b${i++}`} className="font-semibold text-text">{m[2]}</strong>);
    else if (m[4] !== undefined) out.push(<code key={`${keyBase}-c${i++}`} className="mono rounded bg-base px-1 py-0.5 text-[0.85em]">{m[4]}</code>);
    else if (m[6] !== undefined && m[7] !== undefined) out.push(<a key={`${keyBase}-a${i++}`} href={m[7]} target="_blank" rel="noopener noreferrer" className="text-[var(--indigo)] underline underline-offset-2">{m[6]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [text];
}

// A small block-level renderer over the non-code text between fences. It understands headings (#),
// bullet lists (-, *), ordered lists (1.), and paragraphs, and runs renderInline within each. This gives
// answers a clean, readable shape without pulling in a markdown library. The container preserves
// whitespace, so plain prose that uses none of these still renders exactly as written.
function MarkdownBlocks({ text, keyBase }: { text: string; keyBase: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    blocks.push(<p key={`${keyBase}-p${i++}`} className="whitespace-pre-wrap">{renderInline(para.join("\n"), `${keyBase}-p${i}`)}</p>);
    para = [];
  };
  let n = 0;
  while (n < lines.length) {
    const line = lines[n]!;
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) {
      flushPara();
      blocks.push(<div key={`${keyBase}-h${i++}`} className="mt-1 font-semibold text-text">{renderInline(heading[2]!, `${keyBase}-h${i}`)}</div>);
      n++;
    } else if (bullet || ordered) {
      flushPara();
      const items: { text: string; ordered: boolean }[] = [];
      const isOrdered = Boolean(ordered);
      while (n < lines.length) {
        const b = lines[n]!.match(/^\s*[-*]\s+(.*)$/);
        const o = lines[n]!.match(/^\s*\d+[.)]\s+(.*)$/);
        if (!b && !o) break;
        items.push({ text: (b ? b[1] : o![1])!, ordered: Boolean(o) });
        n++;
      }
      const ListTag = isOrdered ? "ol" : "ul";
      blocks.push(
        <ListTag key={`${keyBase}-l${i++}`} className={`my-1 ${isOrdered ? "list-decimal" : "list-disc"} space-y-0.5 pl-5`}>
          {items.map((it, idx) => <li key={idx}>{renderInline(it.text, `${keyBase}-li${idx}`)}</li>)}
        </ListTag>
      );
    } else if (line.trim() === "") {
      flushPara();
      n++;
    } else {
      para.push(line);
      n++;
    }
  }
  flushPara();
  return <>{blocks}</>;
}

// Lightweight rich rendering: fenced ```code``` blocks become styled, copyable code panels; the text
// between them is rendered with a small markdown pass (headings, lists, bold, inline code, links). No
// markdown dependency. While a message is still streaming we render it as plain pre-wrap text so a
// half-arrived fence or list never flashes a broken block; the full markdown pass runs once it settles.
function RichText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  if (streaming) return <span className="whitespace-pre-wrap">{text}</span>;
  if (!text.includes("```")) return <MarkdownBlocks text={text} keyBase="t" />;
  const parts: React.ReactNode[] = [];
  const re = /```(\w+)?\n?([\s\S]*?)```/g;
  let last = 0, i = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<MarkdownBlocks key={i++} text={text.slice(last, m.index)} keyBase={`s${i}`} />);
    parts.push(<CodeBlock key={i++} lang={m[1]} code={m[2]!.replace(/\n$/, "")} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<MarkdownBlocks key={i++} text={text.slice(last)} keyBase={`s${i}`} />);
  return <>{parts}</>;
}

// Staged progress for an in-flight question, so the chat never sits on a bare, endless "resonating"
// spinner. It advances through three honest stages (sent -> resonating -> settling) on a timer that
// roughly tracks askField's collection window, and after a bounded wait it surfaces a calm reassurance
// line so a slow field reads as "still working" rather than "stuck". When the field genuinely returns
// nothing, askField resolves with a graceful "No answer came back" message and a retry, which replaces
// this component; this only covers the waiting period.
function AskProgress({ startedAt }: { startedAt: number }) {
  const STAGES = [
    { k: "Sent", v: "Your question went out to the network." },
    { k: "Resonating", v: "Independent providers are answering it now." },
    { k: "Settling", v: "Their answers are settling on one result, weighted by earned trust." },
  ];
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const iv = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(iv);
  }, [startedAt]);
  // Advance a stage roughly every 6s; cap at the last stage. After ~24s, show the reassurance line.
  const stage = Math.min(STAGES.length - 1, Math.floor(elapsed / 6000));
  const slow = elapsed > 24_000;
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <div className="flex items-center gap-2">
        <Spinner size={16} />
        <span className="text-sm font-medium text-text">{STAGES[stage]!.k}</span>
        <span className="mono text-[11px] text-faint">{Math.floor(elapsed / 1000)}s</span>
      </div>
      <div className="flex items-center gap-1.5">
        {STAGES.map((s, i) => (
          <span key={s.k} title={s.v}
            className={`h-1 flex-1 rounded-full transition-colors ${i < stage ? "bg-[var(--teal)]" : i === stage ? "bg-[color-mix(in_srgb,var(--teal)_55%,transparent)]" : "bg-elevated"}`} />
        ))}
      </div>
      <p className="text-xs text-faint">{STAGES[stage]!.v}</p>
      {slow && <p className="text-xs text-muted">This is taking longer than usual. The network is still working. You can keep waiting, or press Stop and rephrase.</p>}
    </div>
  );
}

function Message({ m, onPick, busy }: { m: ChatMessage; onPick: (opt: string) => void; busy: boolean }) {
  if (m.role === "user") {
    return (
      <div className="fade-in-up flex flex-col items-end">
        <div className="max-w-[82%] rounded-2xl rounded-br-md border border-hairline bg-elevated px-4 py-2.5 text-sm leading-relaxed text-text whitespace-pre-wrap">{m.content}</div>
        <span className="mt-1 pr-1 text-[10px] text-faint">{timeAgo(m.createdAt)}</span>
      </div>
    );
  }
  const pending = !m.content && m.streaming;
  // Once a turn finishes, a clarifying poll or a multi-step plan is rendered as interactive cards. We only
  // parse when not streaming so a half-arrived block never flashes a broken card. Poll takes precedence.
  const poll = !m.streaming ? parsePoll(m.content) : null;
  const plan = !m.streaming && !poll ? parsePlan(m.content) : null;
  const bodyText = pending ? null : (poll ? poll.before : plan ? plan.before : m.content);
  return (
    <div className="fade-in-up flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[11px] font-medium text-faint">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--teal)_40%,transparent)] bg-[color-mix(in_srgb,var(--teal)_12%,transparent)] text-[var(--teal)]">
          <Sparkles size={11} />
        </span>
        <span>Resonator</span>
        {pending && <span className="text-faint">thinking</span>}
      </div>
      {(pending || bodyText) && (
        <div className="max-w-[92%] space-y-1.5 rounded-2xl rounded-tl-md border border-hairline bg-surface px-4 py-3 text-sm leading-relaxed text-text">
          {pending ? <AskProgress startedAt={m.createdAt} /> : <RichText text={bodyText ?? ""} streaming={Boolean(m.streaming)} />}
          {m.streaming && m.content && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-breathe bg-[var(--teal)] align-middle" aria-hidden />}
        </div>
      )}
      {poll && (
        <div className="max-w-[92%] rounded-2xl border border-[color-mix(in_srgb,var(--indigo)_30%,transparent)] bg-[color-mix(in_srgb,var(--indigo)_7%,transparent)] px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--indigo)]"><HelpCircle size={13} /> Quick clarification</div>
          <p className="mb-2.5 text-sm text-text">{poll.question}</p>
          <div className="flex flex-wrap gap-2">
            {poll.options.map((opt) => (
              <button key={opt} disabled={busy} onClick={() => onPick(opt)} className="rounded-lg border border-hairline bg-surface px-3 py-1.5 text-sm text-text transition-colors hover:border-[color-mix(in_srgb,var(--indigo)_45%,transparent)] hover:bg-[color-mix(in_srgb,var(--indigo)_10%,transparent)] disabled:opacity-50">{opt}</button>
            ))}
          </div>
          {poll.after && <p className="mt-2.5 whitespace-pre-wrap text-xs text-muted">{poll.after}</p>}
        </div>
      )}
      {plan && (
        <div className="max-w-[92%] rounded-2xl border border-[color-mix(in_srgb,var(--teal)_30%,transparent)] bg-[color-mix(in_srgb,var(--teal)_7%,transparent)] px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--teal)]"><ListChecks size={13} /> Plan</div>
          <ol className="space-y-1">
            {plan.steps.map((s, idx) => (
              <li key={idx}>
                <button disabled={busy} onClick={() => onPick(`Proceed with this step: ${s}`)}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-text transition-colors hover:bg-[color-mix(in_srgb,var(--teal)_10%,transparent)] disabled:opacity-50">
                  <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--teal)_45%,transparent)] text-[10px] text-[var(--teal)]">{idx + 1}</span>
                  <span className="min-w-0">{s}</span>
                </button>
              </li>
            ))}
          </ol>
          <p className="mt-1.5 px-2 text-[10px] text-faint">Click a step to have the field work on it next.</p>
        </div>
      )}
      {plan?.after && (
        <div className="max-w-[92%] space-y-1.5 rounded-2xl rounded-tl-md border border-hairline bg-surface px-4 py-3 text-sm leading-relaxed text-text">
          <RichText text={plan.after} />
        </div>
      )}
      {!m.streaming && m.content && (
        <div className="flex items-center gap-3 pl-1 text-[10px] text-faint">
          <span>{timeAgo(m.createdAt)}</span>
          <CopyButton text={m.content} />
        </div>
      )}
      {m.receipt && <ReceiptPanel receipt={m.receipt} />}
    </div>
  );
}

// Answer provenance: a default-collapsed "How this was answered" panel that makes the multi-LLM
// coordination visible. It lists the contributing Resonators (provider short address, their domain ZTI,
// and per-contributor confidence) plus the coordinated confidence score. Every field is sourced from the
// answer receipt the field already returns; when a field is absent it is omitted gracefully (no fabricated
// data). The receipt exposes weight = domainZti x confidence, so a contributor's confidence is recovered
// as weight / domainZti when both are present, and otherwise shown as the weight only.
function contributorConfidence(weight: number, domainZti: number): number | null {
  if (!Number.isFinite(weight)) return null;
  if (!Number.isFinite(domainZti) || domainZti <= 0) return null;
  return Math.max(0, Math.min(1, weight / domainZti));
}

function ReceiptPanel({ receipt }: { receipt: AnswerReceipt }) {
  const [open, setOpen] = useState(false);
  const n = receipt.contributors.length;
  const noProviders = n === 0;
  const hasConfidence = Number.isFinite(receipt.fusedConfidence);
  return (
    <Card className="max-w-[92%] p-3">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between text-xs text-muted transition-colors hover:text-text">
        <span className="flex items-center gap-2">
          <ShieldCheck size={14} className={noProviders ? "text-[var(--warn)]" : "text-[var(--teal)]"} />
          {noProviders ? (
            <>Who answered: no provider has answered yet. Cost <span className="mono">0 ZIR</span>.</>
          ) : (
            <>Who answered: {n} provider{n === 1 ? "" : "s"}, weighted by earned trust.{hasConfidence ? <> Coordinated confidence <span className="mono">{formatNum(receipt.fusedConfidence, 2)}</span>.</> : null} Cost <span className="mono">{formatZir(receipt.costUZIR)} ZIR</span>.</>
          )}
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="fade-in-up mt-3 flex flex-col gap-3">
          {noProviders ? (
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] p-2.5 text-xs text-muted">
              Your question went out to the network, but no online provider sent back a signed answer in time. A machine needs to be online and serving answers before the receipt can show who contributed.
            </div>
          ) : (
            <>
              {hasConfidence && (
                <div className="flex items-center justify-between rounded-lg border border-hairline bg-base/60 px-2.5 py-2 text-xs">
                  <span className="text-muted">Coordinated confidence</span>
                  <span className="mono text-text">{formatNum(receipt.fusedConfidence, 2)}</span>
                </div>
              )}
              {receipt.contributors.map((c, i) => {
                // Prefer a node-provided confidence/address if a newer node exposes one; otherwise recover
                // confidence from weight and domain ZTI, and fall back to the provider key for the label.
                const extra = c as typeof c & { confidence?: number; address?: string };
                const conf = Number.isFinite(extra.confidence) ? Math.max(0, Math.min(1, extra.confidence as number)) : contributorConfidence(c.weight, c.domainZti);
                const who = extra.address ? shortAddress(extra.address) : shortHash(c.provider);
                const hasZti = Number.isFinite(c.domainZti);
                return (
                  <div key={i} className="rounded-lg border border-hairline bg-base p-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">{c.label || who} {c.model ? <span className="text-faint">{c.model}</span> : null}</span>
                      <span className="mono text-faint">provider {who}</span>
                    </div>
                    {hasZti && <Meter value={c.domainZti} label="domain ZTI" className="my-1.5" />}
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
                      {conf != null && <span>confidence <span className="mono text-muted">{formatNum(conf, 2)}</span></span>}
                      {Number.isFinite(c.weight) && <span>weight <span className="mono text-muted">{formatNum(c.weight, 2)}</span></span>}
                    </div>
                    {c.excerpt ? <p className="mt-1 text-xs text-muted">{c.excerpt}</p> : null}
                    {c.sig ? (() => {
                      // Actually verify the contributor's ed25519 signature over the exact bytes it signed
                      // (queryId + "\n" + answer) against its public key. A green check means checked, not
                      // decorative. Older nodes that omit the signed payload show an honest "unverifiable".
                      const verifiable = !!c.queryId && typeof c.answer === "string";
                      const ok = verifiable ? edVerify(`${c.queryId}\n${c.answer}`, c.sig, c.provider) : false;
                      return (
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-faint">
                          {ok ? (
                            <><CheckCircle2 size={11} className="text-[var(--teal)]" /> signature verified {shortHash(c.sig)}</>
                          ) : verifiable ? (
                            <><X size={11} className="text-[var(--warn)]" /> signature invalid {shortHash(c.sig)}</>
                          ) : (
                            <><ShieldCheck size={11} className="text-faint" /> signature {shortHash(c.sig)} · unverifiable</>
                          )}
                        </div>
                      );
                    })() : null}
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {receipt.domain ? <Badge tone="neutral">domain: {receipt.domain}</Badge> : null}
                {receipt.proofAvailable && <Badge tone="warn">proof available</Badge>}
                {Number.isFinite(receipt.challengeOpenUntil) && <Badge tone="indigo">challenge open {Math.max(0, Math.round((receipt.challengeOpenUntil - Date.now()) / 60000))}m</Badge>}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
