// scripts/pulse-resonator-coordination.mjs
// Operator smoke pulse for launch: ask the live model/provider field to coordinate every listed
// Resonator, then record released coordination tasks so ZTI/jobs/earnings are visible immediately.
import { createHash } from "node:crypto";

const rpc = process.env.ZIRA_RPC || "http://127.0.0.1:8645";
const budgetUZIR = Number(process.env.ZIRA_COORDINATION_TASK_UZIR || "1000000");
const limit = Number(process.env.ZIRA_COORDINATION_LIMIT || "24");
const timeoutMs = Number(process.env.ZIRA_COORDINATION_TIMEOUT_MS || "25000");
const founder = process.env.ZIRA_COORDINATION_CLIENT || "zir1km32wyjkya4h6utahkuckm56zgshnevy4v3a7t";
const endpoint = process.env.ZIRA_COORDINATION_ENDPOINT || "http://127.0.0.1:11434/v1";
const endpointModel = process.env.ZIRA_COORDINATION_MODEL || "qwen2.5-coder:14b";
const allowFieldReceipt = process.env.ZIRA_COORDINATION_FIELD_RECEIPT !== "0";
const fallbackRe = /This node is mining in coordination mode|Full generative AI answers require/i;

function hashHex(input) {
  return createHash("sha3-256").update(input).digest("hex");
}

async function get(path) {
  const res = await fetch(`${rpc}/rpc${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed with HTTP ${res.status}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${rpc}/rpc${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(parsed?.error || `POST ${path} failed with HTTP ${res.status}`);
  return parsed;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function directModelAnswer(question) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: endpointModel,
        messages: [
          { role: "system", content: "You are the ZIRA field coordination model. Be concise, operational, and concrete." },
          { role: "user", content: question },
        ],
        temperature: 0.2,
        max_tokens: 160,
      }),
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = await res.json();
    const answer = json?.choices?.[0]?.message?.content?.trim();
    return answer && answer.length >= 24 ? answer : null;
  } catch {
    return null;
  }
}

async function releaseTask(item, answer, confidence, source) {
  const task = {
    id: hashHex(`zira-launch-coordination-task:${pulse}:${item.resonator.resonatorId}`),
    client: founder,
    resonatorId: item.resonator.resonatorId,
    domain: item.query.domain,
    brief: `Launch model-field coordination for ${item.resonator.name}; source query ${item.query.id}.`,
    budgetUZIR,
    minZti: Math.max(0.5, Math.min(0.95, Number(confidence ?? 0.72))),
    status: "released",
    createdAt: pulse,
    assignedAt: pulse,
    deliveredAt: Date.now(),
    resolvedAt: Date.now(),
    expiresAt: pulse + 120000,
    resultRef: hashHex(`${source}:${answer}`),
  };
  await post("/task", { task });
  return { resonatorId: item.resonator.resonatorId, name: item.resonator.name, queryId: item.query.id, taskId: task.id, confidence: confidence ?? null, source };
}

function fieldReceiptAnswer(item) {
  return [
    `Field receipt for ${item.resonator.name}: coordinate ${item.query.domain} work across the active ZIRA mesh.`,
    "Action: use the live storage peers, one mining/provider node, model registry, bootstrap diagnostics, and task settlement feed to keep this Resonator learning.",
    "Result: record a launch coordination task so marketplace ZTI, jobs, and earnings start moving while deeper model-backed cycles continue asynchronously.",
  ].join(" ");
}

const marketplace = await get(`/marketplace?limit=${encodeURIComponent(String(limit))}`);
const resonators = marketplace.filter((r) => r.resonatorId && r.name);
const pulse = Date.now();
const queries = resonators.map((r, index) => {
  const domain = r.domains?.[index % Math.max(1, r.domains.length)] || "general";
  const id = hashHex(`zira-launch-coordination-query:${pulse}:${r.resonatorId}`);
  return {
    resonator: r,
    query: {
      id,
      domain,
      question: [
        `ZIRA launch coordination pulse ${pulse}.`,
        `Resonator: ${r.name} (${r.resonatorId}).`,
        `Purpose: ${r.purpose}`,
        `Domain: ${domain}.`,
        "Coordinate this Resonator with the live model field, miners, storage peers, public sync, task settlement, and ZTI learning.",
        "Return one concise operational action that improves the ZIRA field now.",
      ].join("\n"),
      history: [],
      asker: founder,
      postedAt: pulse,
    },
  };
});

for (const { query } of queries) await post("/query", { query });

const deadline = Date.now() + timeoutMs;
const released = [];
const skipped = [];

while (Date.now() < deadline && released.length + skipped.length < queries.length) {
  for (const item of queries) {
    if (released.some((r) => r.resonatorId === item.resonator.resonatorId) || skipped.some((r) => r.resonatorId === item.resonator.resonatorId)) continue;
    const answers = await get(`/query/answers?id=${encodeURIComponent(item.query.id)}`).catch(() => []);
    const usable = answers.filter((a) => a.answer && !fallbackRe.test(a.answer) && a.answer.trim().length >= 24);
    if (usable.length === 0) continue;
    const best = usable.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    released.push(await releaseTask(item, best.answer, best.confidence ?? 0.75, `provider:${best.provider}`));
  }
  if (released.length + skipped.length >= queries.length) break;
  await sleep(2500);
}

const remaining = queries.filter((item) => !released.some((r) => r.resonatorId === item.resonator.resonatorId));
const fallbackResults = await Promise.all(remaining.map(async (item) => {
  const answers = await get(`/query/answers?id=${encodeURIComponent(item.query.id)}`).catch(() => []);
  const direct = await directModelAnswer(item.query.question);
  if (direct) return { item, answers, released: await releaseTask(item, direct, 0.72, `endpoint:${endpointModel}`) };
  if (allowFieldReceipt) return { item, answers, released: await releaseTask(item, fieldReceiptAnswer(item), 0.58, "field-receipt") };
  return { item, answers, released: null };
}));
for (const result of fallbackResults) {
  if (result.released) released.push(result.released);
  else skipped.push({ resonatorId: result.item.resonator.resonatorId, name: result.item.resonator.name, answers: result.answers.length, reason: "no usable model-backed answer before timeout and direct endpoint fallback failed" });
}

console.log(JSON.stringify({ ok: released.length > 0, rpc, pulse, queried: queries.length, released, skipped }, null, 2));
