/**
 * Prove the CREATOR side is a genuine OPEN MARKET — the mirror of external-hire.mjs (which proves the
 * sub-agent side is open). A brand-new creator onboards through the PUBLIC /api/creators/register
 * endpoint with its OWN auto-generated payout wallet and a content sample — no Merit-team seeding, no
 * custody — and then a research run cites + PAYS it for a verified claim. Anyone can plug in and earn
 * on merit; the creators in the demo are not hand-placed by the team.
 *
 * Uses a NICHE question the curated pool can't answer, so the run must rely on this fresh creator —
 * making the citation (and the payment) unambiguously the new creator's. Requires a live LLM writer
 * (STUB=0) so the writer actually reads + cites the registered content.
 *   Run (server up, STUB=0):  node scripts/creator-market.mjs
 */
const BASE = process.env.MERIT_BASE || "http://localhost:3000";

const NAME = "GreenChain Labs";
const CONTENT =
  "GreenChain Labs' June 2026 field study reports that solar-powered validator nodes cut blockchain " +
  "energy consumption by 41% across its pilot networks — the largest validator-efficiency gain measured to date.";
const QUESTION = "How much did solar-powered validator nodes cut blockchain energy consumption in 2026?";

// 1) REGISTER — public endpoint, the creator's OWN auto-generated wallet (non-custodial).
const reg = await fetch(`${BASE}/api/creators/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: NAME, url: "https://greenchain.example/2026-report", price: 0.02, content: CONTENT }),
});
if (!reg.ok) {
  console.error(`/api/creators/register → HTTP ${reg.status} — is the server up at ${BASE}?`);
  process.exit(1);
}
const creator = await reg.json();
console.log(`\nA new creator onboarded through the PUBLIC endpoint — no team seeding, no custody:`);
console.log(`  ${creator.name}  ·  id ${creator.id}  ·  payout wallet ${creator.wallet || "(auto-generated)"}`);
console.log(`  earnable: ${creator.earnable}   ·   ${creator.explorerUrl}\n`);
if (!creator.earnable) {
  console.error("  Creator has no citable content — it can't be paid. Aborting.");
  process.exit(1);
}

// 2) RUN — a question only this creator's content answers; the curated pool is off-topic for it.
console.log(`Asking a question only this creator can answer:\n  "${QUESTION}"`);
console.log(`  …(escrow → cited answer → proof-of-citation → settle); needs a live LLM (STUB=0).\n`);
const run = await fetch(`${BASE}/api/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: QUESTION, budget: 0.5 }),
});
if (!run.ok) {
  console.error(`/api/run → HTTP ${run.status}`);
  process.exit(1);
}

const events = [];
for (const f of (await run.text()).split("\n\n")) {
  const ev = f.match(/^event:\s*(.+)$/m)?.[1]?.trim();
  const dt = f.match(/^data:\s*(.+)$/m)?.[1];
  if (ev && dt) {
    try {
      events.push({ ev, d: JSON.parse(dt) });
    } catch {
      /* skip heartbeats */
    }
  }
}
const mine = (e) => e.d.id === creator.id || e.d.name === creator.name;
const rel = events.filter((e) => e.ev === "release").find(mine);
const ref = events.filter((e) => e.ev === "refund").find(mine);
const summary = events.filter((e) => e.ev === "summary").pop()?.d;

if (rel) {
  console.log(`  ✓ PAID — the brand-new creator earned $${(rel.d.amount || 0).toFixed(4)} for a verified citation`);
  if (rel.d.audit) console.log(`    Auditor: ${rel.d.audit}`);
  if (rel.d.explorerUrl) console.log(`    ${rel.d.explorerUrl}`);
  console.log(`\n  The creator side is a real open market — anyone registers and gets paid on merit. ✓\n`);
} else if (ref) {
  console.log(`  ✗ REFUSED — ${(ref.d.reason || "").split(" — ")[0]}${ref.d.audit ? ` (${ref.d.audit})` : ""}`);
  console.log(`  (The moat refused it — that too is honest: payment requires content that verifiably backs the claim.)\n`);
} else {
  const errs = events.filter((e) => e.ev === "error");
  console.log(`  The creator wasn't cited this run${errs.length ? ` (error: ${errs[0].d.message})` : " (writer didn't use it — rerun with STUB=0 and a live LLM)"}.`);
  if (summary) console.log(`    summary: released ${summary.sources.filter((s) => s.released).length} · refused ${summary.sources.filter((s) => !s.released).length}`);
  console.log("");
}
