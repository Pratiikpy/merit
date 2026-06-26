/**
 * End-to-end smoke test against a running Merit server. Verifies the real
 * invariants of the full agent loop + creator onboarding, so the system can be
 * re-checked with one command before a demo.
 *   Run:  node scripts/smoke.mjs            (default http://localhost:3000)
 *         SMOKE_BASE=https://… node scripts/smoke.mjs
 * Exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync } from "node:fs";

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";
let pass = 0,
  fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`);
  }
}
const approx = (a, b) => Math.abs(a - b) < 1e-6;
const sum = (arr, f) => arr.reduce((n, x) => n + f(x), 0);

function parseSSE(text) {
  const out = [];
  for (const frame of text.split("\n\n")) {
    let type = null,
      data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (type && data) {
      try {
        out.push({ type, data: JSON.parse(data) });
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

console.log(`\nMerit smoke test → ${BASE}\n`);

// 0) health
console.log("[0] GET /api/health");
const hres = await fetch(`${BASE}/api/health`);
const hj = await hres.json();
check("200", hres.status === 200);
check("ok + mode reported", hj.ok === true && (hj.mode === "live" || hj.mode === "stub"));
check("exposes verifiable addresses, never a key", !!hj.contracts?.usdc && !JSON.stringify(hj).match(/PRIVATE_KEY|nvapi-|sk-[a-zA-Z0-9]{6}/));

// 1) sources
console.log("\n[1] GET /api/sources");
const sres = await fetch(`${BASE}/api/sources`);
const sbody = await sres.text();
const sj = JSON.parse(sbody);
check("200", sres.status === 200);
check("returns >= 6 sources", (sj.sources?.length || 0) >= 6, `got ${sj.sources?.length}`);
check("never leaks privateKey or raw content", !sbody.includes("privateKey") && !sbody.includes('"content"'));

// 1b) the specialist-agent marketplace directory (the labor supply side)
console.log("\n[1b] GET /api/agents (specialist marketplace directory)");
const ares = await fetch(`${BASE}/api/agents`);
const abody = await ares.text();
const aj = JSON.parse(abody);
check("200", ares.status === 200);
check(
  "lists hireable specialists with role/price/pay endpoint",
  (aj.agents?.length || 0) >= 5 && aj.agents.every((a) => a.payEndpoint && a.role && typeof a.price === "number"),
  `got ${aj.agents?.length}`,
);
check("never leaks a privateKey", !abody.includes("privateKey"));

// 2) full run
console.log("\n[2] POST /api/run (live agent loop)");
const rres = await fetch(`${BASE}/api/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "What is driving stablecoin payment adoption in 2026?", budget: 0.5 }),
});
check("200", rres.status === 200);
const rawRun = await rres.text();
// The whole run stream — including the summary receipt — must never carry a private key.
check("run SSE (incl. summary) never leaks privateKey", !rawRun.includes("privateKey"));
const events = parseSSE(rawRun);
const releases = events.filter((e) => e.type === "release");
const refunds = events.filter((e) => e.type === "refund");
const errors = events.filter((e) => e.type === "error");
check("at least one release", releases.length >= 1, `${releases.length}`);
check("at least one refusal", refunds.length >= 1, `${refunds.length}`);
check("zero errors", errors.length === 0, errors.map((e) => e.data.message).join("; "));
check("reaches phase=done", events.some((e) => e.type === "phase" && e.data.phase === "done"));
check("stream ends cleanly", events.some((e) => e.type === "end"));
check("every release carries a settlement reference", releases.every((r) => r.data.hash && String(r.data.hash).length > 6));
// The summary receipt: one self-contained, verifiable record of the whole run.
const summary = events.find((e) => e.type === "summary");
check("emits a summary receipt (sources + crew + totals)", !!summary && Array.isArray(summary?.data?.sources) && !!summary?.data?.totals);

// ledger internal consistency (robust to nano>1, unlike escrowed==released+refunded)
const moneyEvents = events.filter((e) => e.data?.ledger);
const led = moneyEvents.length ? moneyEvents[moneyEvents.length - 1].data.ledger : null;
check("final ledger present", !!led);
if (led) {
  check("ledger.released == sum(release amounts)", approx(led.released, sum(releases, (r) => r.data.amount)), JSON.stringify(led));
  check("ledger.refunded == sum(refund amounts)", approx(led.refunded, sum(refunds, (r) => r.data.amount)));
  check("ledger.nano == sum(release nano)", led.nano === sum(releases, (r) => r.data.nano || 0));
  check("no negative ledger values", led.released >= 0 && led.refunded >= 0 && led.escrowed >= 0);
}

// 2b) agent-to-agent: the lead hires + pays its specialist crew (the labor market)
console.log("\n[2b] agent-to-agent: the lead hires + pays its crew");
const hires = events.filter((e) => e.type === "hire");
const hireResults = events.filter((e) => e.type === "hire-result");
const paidCrew = hireResults.filter((e) => e.data.paid === true);
check("lead hires specialists (search/write/verify)", hires.length >= 1, `${hires.length}`);
check("at least one specialist is paid for verified work", paidCrew.length >= 1, `${paidCrew.length}`);
check("each hire exposes the reputation-gated choice (passedOver)", hires.every((h) => Array.isArray(h.data.passedOver)));
if (led) {
  check(
    "labor + creator payouts stay within budget",
    (led.labor || 0) + led.released <= 0.5 + 1e-6,
    `labor=${led.labor} released=${led.released}`,
  );
  check("ledger.labor == sum(paid crew amounts)", approx(led.labor || 0, sum(paidCrew, (c) => c.data.amount)), `labor=${led.labor}`);
}

// 2c) each specialist is a standalone x402 service ANY external agent can pay
console.log("\n[2c] specialists are real x402 services (externally payable)");
const payProbe = await fetch(`${BASE}/api/agent/scout/pay`);
check("unpaid specialist call → 402 (payment required)", payProbe.status === 402);
const challengeHdr = payProbe.headers.get("payment-required");
check("returns an x402 payment challenge", !!challengeHdr);
if (challengeHdr) {
  let ch = null;
  try {
    ch = JSON.parse(Buffer.from(challengeHdr, "base64").toString("utf-8"));
  } catch {
    /* leave null */
  }
  const accept = ch?.accepts?.[0];
  check(
    "challenge pays the specialist's own wallet on Arc",
    /^0x[0-9a-fA-F]{40}$/.test(accept?.payTo || "") && String(accept?.network || "").includes("5042002"),
    accept?.payTo,
  );
  check("challenge amount equals the specialist's price (6000 = $0.006)", accept?.amount === "6000", `amount=${accept?.amount}`);
}

// 2d) a ZERO budget must pay NOTHING (whole-run budget invariant at the limit — guards
// against the `Number(x) || default` foot-gun that silently coerces 0 to the default)
console.log("\n[2d] budget=0 pays nothing");
const zres = await fetch(`${BASE}/api/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "What is driving stablecoin payment adoption in 2026?", budget: 0 }),
});
const zev = parseSSE(await zres.text());
const zled = zev.filter((e) => e.data?.ledger).map((e) => e.data.ledger).pop();
check("zero-budget run has no errors", !zev.some((e) => e.type === "error"));
check("zero-budget pays no specialists (labor == 0)", !zled || (zled.labor || 0) === 0, `labor=${zled?.labor}`);
check("zero-budget releases nothing (released == 0)", !zled || zled.released === 0, `released=${zled?.released}`);

// 2e) an OFF-TOPIC question (no source addresses it) must pay NO creators — the moat refusing to
// pay for a question the sources can't answer. Guards the off-topic fix at the e2e level (where a
// unit test once falsely passed): live path = the writer's NO_RELEVANT_SOURCES; offline = the
// deterministic ≥2-shared-words guard.
console.log("\n[2e] off-topic question pays no creators");
const ores = await fetch(`${BASE}/api/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "What is the capital of France and its population?", budget: 0.5 }),
});
const oev = parseSSE(await ores.text());
const oReleases = oev.filter((e) => e.type === "release");
const oled = oev.filter((e) => e.data?.ledger).map((e) => e.data.ledger).pop();
check("off-topic run has no errors", !oev.some((e) => e.type === "error"));
check(
  "off-topic question releases no creators (released == 0)",
  oReleases.length === 0 && (!oled || oled.released === 0),
  `releases=${oReleases.length}`,
);

// 3) creator onboarding
console.log("\n[3] POST /api/creators/register");
const creg = await fetch(`${BASE}/api/creators/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Smoke Test Co", price: 0.01 }),
});
const cbody = await creg.text();
const cj = JSON.parse(cbody);
check("200", creg.status === 200);
check("generates a real EOA wallet", /^0x[0-9a-fA-F]{40}$/.test(cj.wallet || ""), cj.wallet);
check("response never leaks privateKey", !cbody.includes("privateKey"));

// 4) on-chain reputation read
console.log("\n[4] GET /api/reputation/:id (recompute reputation from chain)");
const rep = await fetch(`${BASE}/api/reputation/stabledata`);
const rj = await rep.json();
check("200", rep.status === 200);
check("reports the ReputationRegistry contract", !!rj.reputationRegistry);
// onchain is null when REPUTATION_ONCHAIN=0; only assert its shape when present
if (rj.onchain) {
  check("on-chain reputation decodes feedback scores", Array.isArray(rj.onchain.scores));
  check("aggregate matches the scores", rj.onchain.count === rj.onchain.scores.length);
  check(
    "exposes a verifiable feedback timeline (every event with a tx link)",
    Array.isArray(rj.onchain.feedback) &&
      rj.onchain.feedback.length === rj.onchain.count &&
      rj.onchain.feedback.every((f) => typeof f.score === "number" && f.tx && f.explorerUrl),
  );
}

// 4b) the SAME endpoint resolves specialist agents — agent reputation is verifiable too
console.log("\n[4b] GET /api/reputation/:specialist (agent reputation from chain)");
const srep = await fetch(`${BASE}/api/reputation/scout`);
const srj = await srep.json();
check("200", srep.status === 200);
check("resolves the specialist agent", srj.kind === "specialist" && srj.role === "search", JSON.stringify({ kind: srj.kind, role: srj.role }));
check("reports the ReputationRegistry contract", !!srj.reputationRegistry);
if (srj.onchain) check("specialist on-chain reputation decodes scores", Array.isArray(srj.onchain.scores));

// 5) the MCP server speaks the protocol (the distribution surface any MCP client uses). A pure stdio
//    handshake — needs no Merit server — so it locks the protocol shape into the regression.
console.log("\n[5] MCP server handshake (scripts/mcp-server.mjs)");
const mcpPath = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
const mcpOut = await new Promise((resolve) => {
  const child = spawn(process.execPath, [mcpPath], { stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  const finish = () => { try { child.kill(); } catch { /* already gone */ } resolve(out); };
  const timer = setTimeout(finish, 5000);
  child.stdout.on("data", (d) => { out += d; if (out.includes('"id":2')) { clearTimeout(timer); finish(); } });
  child.on("error", () => { clearTimeout(timer); resolve(""); });
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
});
const mcpMsgs = mcpOut.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const initRes = mcpMsgs.find((m) => m.id === 1)?.result;
const listRes = mcpMsgs.find((m) => m.id === 2)?.result;
check("initialize returns protocolVersion + serverInfo", !!initRes?.protocolVersion && initRes?.serverInfo?.name === "merit");
check("advertises the tools capability", !!initRes?.capabilities?.tools);
check(
  "tools/list exposes merit_research with a question input",
  listRes?.tools?.[0]?.name === "merit_research" && !!listRes?.tools?.[0]?.inputSchema?.properties?.question,
);

// [6] verify-all composes the four verifiers into one report — it must run cleanly on the run's own
// receipt. (STUB receipts carry no real on-chain verdicts, so this confirms the script loads + the
// signature/verdict sections render + it exits 0; the live cross-check is exercised manually on Arc.)
console.log("\n[6] verify-all composes the verifiers on the receipt");
if (summary?.data) {
  const vaScript = fileURLToPath(new URL("./verify-all.mjs", import.meta.url));
  const vaReceipt = fileURLToPath(new URL("./_smoke_receipt.json", import.meta.url));
  writeFileSync(vaReceipt, JSON.stringify(summary.data));
  const va = await new Promise((resolve) => {
    const child = spawn(process.execPath, [vaScript, vaReceipt], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => resolve({ code: 1, out }));
    child.on("close", (code) => resolve({ code, out }));
  });
  try { unlinkSync(vaReceipt); } catch { /* already gone */ }
  check("verify-all runs cleanly on the run's receipt (exit 0)", va.code === 0, `exit=${va.code}`);
  check("verify-all renders the signature + verdict sections", va.out.includes("[1] Signature") && va.out.includes("[2] Verdicts"));
}

// [7] leaderboard ranks the whole roster by ERC-8004 reputation — must run cleanly against the live
// server. (STUB carries no on-chain feedback, so this confirms the roster loads, ranks, and the table
// renders + it exits 0; the on-chain columns are exercised manually on Arc.)
console.log("\n[7] leaderboard ranks the two-sided roster");
{
  const lbScript = fileURLToPath(new URL("./leaderboard.mjs", import.meta.url));
  const lb = await new Promise((resolve) => {
    const child = spawn(process.execPath, [lbScript], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MERIT_BASE: BASE } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => resolve({ code: 1, out }));
    child.on("close", (code) => resolve({ code, out }));
  });
  check("leaderboard runs cleanly against the server (exit 0)", lb.code === 0, `exit=${lb.code}`);
  check("leaderboard renders the reputation-economy table with ranked agents", lb.out.includes("reputation economy") && /\d+ agents in the market/.test(lb.out));
}

// [8] the challenge endpoint re-audits a verdict — confirm it validates input (400 on a missing claim)
// and degrades gracefully when the LLM judge is unavailable (503 under STUB; live it returns a verdict).
// The actual SUPPORTED/REFUSED re-audit is exercised live on Arc (the judge needs a real LLM).
console.log("\n[8] challenge re-audits a verdict (input validation + graceful no-LLM)");
{
  const bad = await fetch(`${BASE}/api/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "StableData API" }) });
  check("challenge rejects a missing claim (400)", bad.status === 400, `status=${bad.status}`);
  const ok = await fetch(`${BASE}/api/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "StableData API", claim: "cross-border settlement drives stablecoin adoption" }) });
  check("challenge answers a well-formed request (200 verdict live, or 503 when no LLM)", ok.status === 200 || ok.status === 503, `status=${ok.status}`);
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
