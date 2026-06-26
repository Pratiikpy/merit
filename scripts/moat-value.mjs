/**
 * The economic case for proof-of-citation — Merit vs "pay-then-pray".
 *
 * Today's agent-payment rails (x402, Skyfire, Bazaar…) move money but pay for data/work UP FRONT,
 * with no proof it was used or correct. Merit pays ONLY sources whose content verifiably supported
 * the answer, and refuses the rest. This runs a real Merit run and quantifies the difference: the
 * money a pay-then-pray rail pays out blindly to sources Merit PROVED didn't earn it — including an
 * unverifiable identity. The moat isn't decorative; it's the spend it protects.
 *
 *   Run (server must be up):  node scripts/moat-value.mjs  ["question"]  [budget]
 */
const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const QUESTION = process.argv[2] || "What is driving stablecoin payment adoption in 2026?";
const BUDGET = Number(process.argv[3] || 0.5);
const usd = (n) => "$" + (Math.round((n || 0) * 1e6) / 1e6).toFixed(4);

// Each source's asking price — what a pay-then-pray rail would pay it for its data.
const srcRes = await fetch(`${BASE}/api/sources?question=${encodeURIComponent(QUESTION)}&budget=${BUDGET}`);
if (!srcRes.ok) throw new Error(`/api/sources ${srcRes.status} — is the server running at ${BASE}?`);
const priceByName = new Map(((await srcRes.json()).sources || []).map((s) => [s.name, s.price]));

// Run the agent and read its self-contained summary receipt.
const runRes = await fetch(`${BASE}/api/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: QUESTION, budget: BUDGET }),
});
if (!runRes.ok) throw new Error(`/api/run ${runRes.status} — is the server running at ${BASE}?`);
let summary = null;
for (const block of (await runRes.text()).split("\n\n")) {
  const ev = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
  const dt = block.match(/^data:\s*(.+)$/m)?.[1];
  if (ev === "summary" && dt) {
    try {
      summary = JSON.parse(dt);
    } catch {
      /* ignore a partial frame */
    }
  }
}
if (!summary) throw new Error("run did not emit a summary receipt — did it complete?");

const paid = summary.sources.filter((s) => s.released);
const refused = summary.sources.filter((s) => !s.released);
const meritPaid = summary.totals.released;
const wasted = refused.reduce((a, s) => a + (priceByName.get(s.name) || 0), 0);
const total = summary.sources.length;
const failPct = total ? Math.round((refused.length / total) * 100) : 0;

console.log(`\nMerit — the economic case for proof-of-citation`);
console.log(`(q: "${QUESTION.slice(0, 52)}…", budget ${usd(BUDGET)})\n`);
console.log(`  Sources evaluated: ${total}   →   PAID ${paid.length} (verified + supported)   ·   REFUSED ${refused.length}\n`);
console.log(`  Merit pays only for proven value:   ${usd(meritPaid)}  to ${paid.length} source(s) the Auditor verified`);
console.log(`  Merit REFUSED (would-be waste):     ${usd(wasted)}  a pay-then-pray rail pays out blindly\n`);
console.log("  What it refused — and what pay-then-pray would have paid for:");
for (const s of refused) {
  console.log(`    • ${s.name}  (${usd(priceByName.get(s.name))})  —  ${s.reason}`);
}
console.log(
  `\n  ${failPct}% of the sources here didn't earn payment, yet a pay-then-pray rail pays them all\n` +
    "  anyway — for work Merit proved didn't earn it. Anyone can pay; only Merit decides who EARNED it.\n",
);
