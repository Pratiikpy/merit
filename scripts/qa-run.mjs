// QA SSE run driver (TEST-PLAN §5.2/§12). Drives a real /api/run, parses the SSE stream, asserts the run
// reaches a terminal state, and reconciles the settlement (released + refunded ≈ escrowed). Appends to
// qa-run-report.md. Run: QA_BASE=https://merit-ecru.vercel.app node scripts/qa-run.mjs
import fs from "node:fs";
import { recoverMessageAddress } from "viem";

function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === "object") return Object.keys(v).sort().reduce((a, k) => { a[k] = sortKeys(v[k]); return a; }, {}); return v; }
const canonicalize = (v) => JSON.stringify(sortKeys(v));

const BASE = process.env.QA_BASE || "https://merit-ecru.vercel.app";
const QUESTION = process.env.QA_QUESTION || "What is driving stablecoin payment adoption in 2026?";
const out = [];
const rec = (name, pass, detail) => { out.push({ name, pass, detail: detail || "" }); const m = pass === true ? "PASS" : pass === "warn" ? "WARN" : "FAIL"; console.log(`[${m}] ${name}${detail ? " — " + detail : ""}`); };

console.log(`\n=== Merit run QA — ${BASE} ===\n`);
const resp = await fetch(BASE + "/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: QUESTION, budget: 0.3, discover: false }) });
rec("POST /api/run → 200 SSE", resp.status === 200 && (resp.headers.get("content-type") || "").includes("event-stream"), `${resp.status} ${resp.headers.get("content-type")}`);

const events = [];
let summary = null, sawError = null;
const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = "";
const deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const frames = buf.split("\n\n");
  buf = frames.pop() || "";
  for (const f of frames) {
    const ev = (f.match(/^event:\s*(.+)$/m) || [])[1]?.trim();
    const dm = f.match(/^data:\s*(.+)$/m);
    if (!ev) continue;
    events.push(ev);
    let d = {}; if (dm) { try { d = JSON.parse(dm[1]); } catch {} }
    if (ev === "summary") summary = d;
    if (ev === "error") sawError = d;
    if (ev === "end") { /* terminal */ }
  }
}
const uniq = [...new Set(events)];
rec("stream emitted events", events.length > 0, `${events.length} events: ${uniq.join(", ")}`);
rec("no error event", !sawError, sawError ? JSON.stringify(sawError).slice(0, 120) : "clean");
rec("reached terminal state (summary + end)", uniq.includes("summary") && uniq.includes("end"), `summary=${uniq.includes("summary")} end=${uniq.includes("end")}`);

// Reconciliation from the summary event — totals are nested under `summary.totals`.
if (summary) {
  const t = summary.totals || summary;
  const esc = Number(t.escrowed ?? t.escrowedTotal ?? t.deposited ?? t.escrow ?? NaN);
  const rel = Number(t.released ?? t.releasedTotal ?? t.release ?? NaN);
  const ref = Number(t.refunded ?? t.refundedTotal ?? t.refund ?? NaN);
  if ([esc, rel, ref].every((x) => Number.isFinite(x))) {
    rec("money conserved (released + refunded ≈ escrowed)", Math.abs(rel + ref - esc) <= 1e-6 + Math.abs(esc) * 0.02, `esc=${esc} rel=${rel} ref=${ref}`);
  } else {
    rec("summary carries settlement totals", "warn", `totals keys: ${Object.keys(t).join(",")}`);
  }
  // The run summary is itself a signed receipt — verify the signer recovers offline.
  if (summary.signer && summary.signature) {
    try { const { signer, signature, ...rest } = summary; const r = await recoverMessageAddress({ message: canonicalize(rest), signature }); rec("run summary signature recovers signer (offline)", r.toLowerCase() === signer.toLowerCase(), r.toLowerCase() === signer.toLowerCase() ? `signer ${signer}` : `recovered ${r} != ${signer}`); }
    catch (e) { rec("run summary signature recovers signer (offline)", false, String(e).slice(0, 80)); }
  } else rec("run summary signed", "warn", "no signer (keyless/stub)");
} else {
  rec("summary event present", false, "no summary captured");
}

const pass = out.filter((r) => r.pass === true).length;
const fail = out.filter((r) => r.pass !== true && r.pass !== "warn");
const lines = [`# Merit — SSE run QA report`, ``, `Target: **${BASE}** · question: "${QUESTION}"`, ``, `Events observed: \`${uniq.join(", ")}\``, ``, `| Result | Check | Detail |`, `|---|---|---|`, ...out.map((r) => `| ${r.pass === true ? "🟢" : r.pass === "warn" ? "🟡" : "🔴"} | ${r.name} | ${String(r.detail).replace(/\|/g, "\\|")} |`)];
fs.writeFileSync("qa-run-report.md", lines.join("\n") + "\n");
console.log(`\n=== ${pass} pass · ${fail.length} fail — wrote qa-run-report.md ===`);
process.exit(fail.length ? 1 : 0);
