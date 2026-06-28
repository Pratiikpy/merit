/**
 * Merit MCP server — exposes Merit as ONE callable tool over the Model Context Protocol (stdio), so any
 * MCP client (Claude, Gemini CLI, Cursor, …) can ask a research question with a USDC budget and get back
 * a verified, citation-paid answer + the on-chain receipt. Reuses the live /api/run SSE pipeline, so the
 * tool does the full loop: hire crew → cited answer → proof-of-citation → pay verified sources / refuse the
 * rest → ERC-8004 reputation + validation. Dependency-free: speaks JSON-RPC 2.0 over stdio (newline-framed),
 * implementing initialize / tools/list / tools/call — the core MCP surface a client needs.
 *
 * Wire into an MCP client config (Merit server must be running):
 *   { "mcpServers": { "merit": { "command": "node", "args": ["scripts/mcp-server.mjs"],
 *       "env": { "MERIT_BASE": "http://localhost:3000" } } } }
 *
 *   Smoke it by hand:  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
 *                        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node scripts/mcp-server.mjs
 */
const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const SERVER_INFO = { name: "merit", version: "1.0.0" };

const TOOL = {
  name: "merit_research",
  description:
    "Ask Merit (a research agent on Circle's Arc L1) a question with a USDC budget. Merit hires specialist " +
    "sub-agents, writes a cited answer, verifies each citation with an adversarial proof-of-citation judge, " +
    "pays only the sources whose content was actually used (sub-cent USDC on Arc) and refuses the rest, and " +
    "records on-chain ERC-8004 reputation + validation. Returns the answer plus a receipt: who was paid or " +
    "refused and why, with Arc tx links. Each call SPENDS real sub-cent USDC and is NOT idempotent — on a " +
    "network timeout the run may have already settled, so verify before retrying (e.g. `npm run verify-settlement`) " +
    "rather than blindly re-calling, which would pay again.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The research question to answer." },
      budget: { type: "number", description: "USDC budget for the run (default 0.5, clamped to [0, 5])." },
      discover: { type: "boolean", description: "If true, discover real publishers live from the web instead of the curated pool." },
      tier: { type: "string", enum: ["pro", "budget"], description: "Crew tier: 'pro' (LLM-judge verify) or 'budget' (similarity-only, cheaper)." },
    },
    required: ["question"],
  },
  // MCP tool annotations (2025 spec) so any client can warn the user before invoking: merit_research is the
  // textbook destructive / non-idempotent / open-world tool — it settles REAL (testnet) USDC + writes
  // ERC-8004 reputation/validation on-chain, calls an LLM + external sources, and each call pays again.
  annotations: {
    title: "Verified Research + Pay (real USDC on Arc)",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

// The Citation Verification Oracle as an MCP tool — the truth-check ANY agent can call before paying a
// citation. This is how Merit spreads: a question-asker tool spreads questions; THIS spreads the verifier
// every reading agent (self-report ones included) needs underneath so it never pays for a hallucination.
const VERIFY_TOOL = {
  name: "verify_citation",
  description:
    "Verify whether a citation is GROUNDED before paying for it. Give Merit's Citation Verification Oracle a " +
    "(claim, source) pair; it runs a deterministic numeric verifier + an adversarial proof-of-citation judge " +
    "and returns a SIGNED, tamper-evident verdict (SUPPORTED/REFUSED) a settlement hook can consume so a " +
    "hallucinated citation never settles. Read-only, idempotent, spends no USDC. Use it to gate ANY agent's " +
    "citation payments — including self-report agents whose 'citation' is one LLM grading its own homework.",
  inputSchema: {
    type: "object",
    properties: {
      claim: { type: "string", description: "The cited claim — the sentence the source is cited for." },
      source: { type: "string", description: "The source content the claim should be grounded in (raw text)." },
    },
    required: ["claim", "source"],
  },
  annotations: { title: "Verify a citation (signed grounding oracle)", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
const ok = (id, res) => send({ jsonrpc: "2.0", id, result: res });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

function parseSSE(text) {
  const out = [];
  for (const frame of text.split("\n\n")) {
    let ev = null,
      data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
    }
    if (ev && data) {
      try {
        out.push({ ev, d: JSON.parse(data) });
      } catch {
        /* skip heartbeats / partials */
      }
    }
  }
  return out;
}

// A handled failure carries `retryable` so the calling agent can decide what to do. But NEVER blind-retry:
// merit_research spends USDC and is non-idempotent — retry only after confirming nothing settled.
const meritErr = (message, retryable) => Object.assign(new Error(message), { retryable });

async function runMerit(args) {
  const question = String(args.question || "").trim();
  if (!question) throw meritErr("`question` is required and must be a non-empty string.", false);
  const body = { question, budget: Number.isFinite(args.budget) ? args.budget : 0.5 };
  if (args.discover) body.discover = true;
  if (args.tier === "pro" || args.tier === "budget") body.tier = args.tier;
  const res = await fetch(`${BASE}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((e) => {
    throw meritErr(`cannot reach Merit at ${BASE} (${e.message}) — is the server running?`, true);
  });
  if (!res.ok) throw meritErr(`Merit /api/run returned HTTP ${res.status}`, res.status >= 500 || res.status === 429 || res.status === 408);
  const events = parseSSE(await res.text());
  const answer = events.filter((e) => e.ev === "answer").pop()?.d;
  const summary = events.filter((e) => e.ev === "summary").pop()?.d;
  const text = answer?.segments
    ? answer.segments
        .map((s) => (s.t != null ? s.t : s.c != null ? `[${s.c}]` : ""))
        .join("")
        .replace(/\s+/g, " ")
        .trim()
    : "(no answer produced)";

  const lines = [`ANSWER\n${text}\n`];
  if (summary?.sources) {
    const paid = summary.sources.filter((s) => s.released);
    const refused = summary.sources.filter((s) => !s.released);
    lines.push(`CREATORS PAID — proof-of-citation verified (${paid.length}):`);
    for (const s of paid)
      lines.push(`  ✓ ${s.name} — $${(s.amount || 0).toFixed(4)}${s.reason ? ` (${s.reason})` : ""}${s.explorerUrl ? `  ${s.explorerUrl}` : ""}`);
    if (refused.length) {
      lines.push(`REFUSED — no payment (${refused.length}):`);
      for (const s of refused) lines.push(`  ✗ ${s.name} — ${s.reason || ""}`);
    }
    const t = summary.totals || {};
    lines.push(`\nSETTLEMENT  released $${(t.released || 0).toFixed(4)} · refunded $${(t.refunded || 0).toFixed(4)} · agent-labor $${(t.labor || 0).toFixed(4)}`);
  }
  const errs = events.filter((e) => e.ev === "error");
  if (errs.length) lines.push("ERRORS: " + errs.map((e) => e.d.message).join("; "));
  return lines.join("\n");
}

async function runVerify(args) {
  const claim = String(args.claim || "").trim();
  const source = String(args.source || "").trim();
  if (!claim || !source) throw meritErr("`claim` and `source` are both required (raw text).", false);
  const res = await fetch(`${BASE}/api/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim, source }),
  }).catch((e) => {
    throw meritErr(`cannot reach Merit at ${BASE} (${e.message}) — is the server running?`, true);
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw meritErr(v.error || `Merit /api/verify returned HTTP ${res.status}`, res.status >= 500 || res.status === 429);
  return [
    `VERDICT  ${v.verdict}  (${v.grounded ? "grounded" : "NOT grounded"})`,
    `checked by: ${v.by}`,
    `reasoning: ${v.reasoning}`,
    `settlement: ${v.settlement}`,
    v.signature ? `signed verdict — signer ${v.signer}, sig ${String(v.signature).slice(0, 18)}… (re-canonicalize the body to verify offline)` : "",
  ].filter(Boolean).join("\n");
}

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore non-JSON noise
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    ok(id, { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  } else if (typeof method === "string" && method.startsWith("notifications/")) {
    // notifications have no response
  } else if (method === "tools/list") {
    ok(id, { tools: [TOOL, VERIFY_TOOL] });
  } else if (method === "tools/call") {
    const handlers = { [TOOL.name]: runMerit, [VERIFY_TOOL.name]: runVerify };
    const fn = handlers[params?.name];
    if (!fn) {
      fail(id, -32602, `Unknown tool: ${params?.name}`);
      return;
    }
    try {
      const text = await fn(params.arguments || {});
      ok(id, { content: [{ type: "text", text }] });
    } catch (e) {
      // Structured, machine-readable tool error so the calling agent can reason (retry vs give up) rather
      // than parse a string. retryable=false for bad input, true for connectivity/5xx. Never blind-retry.
      const payload = { error: { message: e.message, retryable: e.retryable === true } };
      ok(id, { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true });
    }
  } else if (method === "ping") {
    ok(id, {});
  } else if (id !== undefined) {
    fail(id, -32601, `Method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
