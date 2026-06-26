/**
 * Example client — drive a Merit research run programmatically (no browser) and
 * print a human-readable receipt: the answer, the specialist agents hired + paid,
 * the creators paid (with proof-of-citation scores + Arc tx links) and the ones
 * refused. Shows Merit as a composable service any agent or app can call — and that
 * it handles an arbitrary question autonomously, not a scripted one.
 *   Run:  node scripts/example-client.mjs ["your question"] [budget] [--discover]
 *         (--discover pulls live web sources via RSS instead of the curated pool)
 *         MERIT_BASE=https://your-host node scripts/example-client.mjs
 */
const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const discover = process.argv.includes("--discover"); // --discover → live-web sources, not curated
const args = process.argv.slice(2).filter((a) => a !== "--discover");
const question = args[0] || "What is driving stablecoin payment adoption in 2026?";
const budgetArg = Number(args[1]);
const budget = Number.isFinite(budgetArg) ? budgetArg : 0.5;

const usd = (n) => "$" + (Number(n) || 0).toFixed(4);
// Cap a name for the receipt: discovered sources are full article titles, which otherwise run long.
const short = (s) => (String(s).length > 40 ? String(s).slice(0, 39) + "…" : String(s));

function parseSSE(text) {
  const out = [];
  for (const frame of text.split("\n\n")) {
    let type = null;
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (type && data) {
      try {
        out.push({ type, data: JSON.parse(data) });
      } catch {
        /* skip non-JSON frames (heartbeats) */
      }
    }
  }
  return out;
}

console.log(`\nMerit · asking the agent:\n  "${question}"   (budget ${usd(budget)}${discover ? " · live-web sources" : ""})\n`);
console.log("  …running (escrow → answer → verify → settle); takes ~30–45s on the live chain.\n");

const res = await fetch(`${BASE}/api/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question, budget, ...(discover ? { discover: true } : {}) }),
});
if (!res.ok) {
  console.error(`run failed: HTTP ${res.status} — is the server up at ${BASE}?`);
  process.exit(1);
}
const events = parseSSE(await res.text());

const answer = events.filter((e) => e.type === "answer").pop();
if (answer?.data?.segments) {
  // Render citation segments as [Source] so they read as distinct references, not blended prose.
  const text = answer.data.segments.map((s) => (s.t != null ? s.t : s.c != null ? `[${s.c}]` : "")).join("");
  console.log("ANSWER");
  console.log("  " + text.replace(/\s+/g, " ").trim().replace(/(.{90}\S*)\s/g, "$1\n  ") + "\n");
}

const hires = events.filter((e) => e.type === "hire");
const hireResults = events.filter((e) => e.type === "hire-result");
if (hires.length) {
  console.log("CREW  (agent → agent · paid only for verified work)");
  for (const h of hires) {
    const sp = h.data.specialist;
    const r = hireResults.find((x) => x.data.id === sp.id);
    const over = (h.data.passedOver || []).map((p) => `${p.name} (${p.merit})`).join(", ");
    const status = r?.data.paid ? `paid ${usd(r.data.amount)}` : "refused";
    console.log(`  ${sp.name.padEnd(9)} ${sp.role.padEnd(7)} ${status}${over ? `   chosen over ${over}` : ""}`);
  }
  console.log("");
}

const releases = events.filter((e) => e.type === "release");
const refunds = events.filter((e) => e.type === "refund");
console.log("CREATORS  (agent → creator · proof-of-citation gated)");
for (const r of releases) {
  // Prefer the Auditor's verdict reason (the LLM judge); fall back to the similarity
  // score when the judge was offline.
  const why = r.data.audit ? `  ✓ ${r.data.audit}` : r.data.support > 0 ? `  proof ${Number(r.data.support).toFixed(2)}` : "";
  console.log(`  ✓ ${short(r.data.name).padEnd(22)} paid ${usd(r.data.amount)}${why}`);
  if (r.data.explorerUrl) console.log(`      ${r.data.explorerUrl}`);
}
for (const r of refunds) {
  const detail = r.data.audit ? ` (${r.data.audit})` : "";
  console.log(`  ✗ ${short(r.data.name).padEnd(22)} refused — ${(r.data.reason || "").split(" — ")[0]}${detail}`);
}

const led = events
  .filter((e) => e.data?.ledger)
  .map((e) => e.data.ledger)
  .pop();
if (led) {
  console.log(
    `\nSETTLEMENT  released ${usd(led.released)} · refunded ${usd(led.refunded)} · ` +
      `agent-labor ${usd(led.labor || 0)}  →  total ${usd((led.released || 0) + (led.labor || 0))} ≤ budget ${usd(budget)}`,
  );
}

// The full on-chain footprint per source: the USDC settlement AND both ERC-8004 registry writes
// (reputation feedback + the Auditor's validation verdict) — all three registries, all verifiable on Arc.
const summary = events.filter((e) => e.type === "summary").pop()?.data;
if (summary?.sources?.some((s) => s.tx || s.reputationTx || s.validationTx)) {
  console.log("\nON-CHAIN FOOTPRINT  (Arc — real USDC settlement + all 3 ERC-8004 registries: reputation + validation)");
  for (const s of summary.sources) {
    const parts = [];
    if (s.tx) parts.push(s.onchain ? `settle      ${s.explorerUrl}` : `settle      ${s.tx}  (not yet a resolvable tx — Gateway batch pending, or simulated under STUB)`);
    if (s.reputationTx) parts.push(s.reputationUrl ? `reputation  ${s.reputationUrl}` : `reputation  ${s.reputationTx}  (simulated under STUB)`);
    if (s.validationTx) parts.push(s.validationUrl ? `validation  ${s.validationUrl}` : `validation  ${s.validationTx}  (simulated under STUB)`);
    if (parts.length) {
      console.log(`  ${short(s.name)}`);
      for (const p of parts) console.log(`      ${p}`);
    }
  }
}
const errs = events.filter((e) => e.type === "error");
if (errs.length) console.log("ERRORS: " + errs.map((e) => e.data.message).join("; "));
console.log("");
