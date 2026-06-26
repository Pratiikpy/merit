/**
 * Pro crew vs economy crew — makes Merit's agent-labor market tangible.
 *
 * Runs the SAME question + budget twice: once with the proven pros (default) and once
 * with the budget crew (`{"tier":"budget"}`). Prints them side by side — who was hired,
 * their reputation, the verification capability you're buying, the labor cost, and the
 * settlement outcome. The point: the economy crew is cheaper but buys similarity-only
 * verification (Tally) instead of the Auditor's LLM judge — it can't catch a hollow citation.
 *
 *   Run (server must be up):  node scripts/compare-crews.mjs
 */
const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const QUESTION = process.argv[2] || "What is driving stablecoin payment adoption in 2026?";
const BUDGET = Number(process.argv[3] || 0.5);

async function run(tier) {
  const body = JSON.stringify({ question: QUESTION, budget: BUDGET, ...(tier ? { tier } : {}) });
  const res = await fetch(`${BASE}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`/api/run ${res.status} — is the server running at ${BASE}?`);
  const text = await res.text();
  const events = [];
  for (const block of text.split("\n\n")) {
    const ev = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const dt = block.match(/^data:\s*(.+)$/m)?.[1];
    if (ev && dt) {
      try {
        events.push({ ev, d: JSON.parse(dt) });
      } catch {
        /* skip heartbeats / partials */
      }
    }
  }
  const hires = events.filter((e) => e.ev === "hire").map((e) => e.d.specialist);
  const crew = hires.map((s) => ({ name: s.name, role: s.role, merit: s.merit, price: s.price, capability: s.capability }));
  const labor = Math.round(crew.reduce((a, s) => a + (s.price || 0), 0) * 1e6) / 1e6;
  const verify = crew.find((s) => s.role === "verify");
  return {
    crew,
    labor,
    verifyCapability: verify?.capability ?? "—",
    releases: events.filter((e) => e.ev === "release").length,
    refunds: events.filter((e) => e.ev === "refund").length,
    errors: events.filter((e) => e.ev === "error").length,
  };
}

function col(s, w) {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

const pro = await run(undefined);
const eco = await run("budget");

const W = 36;
console.log(`\nMerit — pro crew vs economy crew   (q: "${QUESTION.slice(0, 48)}…", budget $${BUDGET})\n`);
console.log("  " + col("PRO CREW (default — by reputation)", W) + "ECONOMY CREW ({\"tier\":\"budget\"})");
console.log("  " + col("─".repeat(34), W) + "─".repeat(30));
for (let i = 0; i < Math.max(pro.crew.length, eco.crew.length); i++) {
  const p = pro.crew[i], e = eco.crew[i];
  const pLine = p ? `${p.role}: ${p.name} (merit ${p.merit})` : "";
  const eLine = e ? `${e.role}: ${e.name} (merit ${e.merit})` : "";
  console.log("  " + col(pLine, W) + eLine);
}
console.log("  " + col("─".repeat(34), W) + "─".repeat(30));
const shortVerify = (cap) => (/LLM judge/i.test(cap) ? "LLM judge" : "similarity-only");
console.log("  " + col(`labor cost: $${pro.labor.toFixed(4)}`, W) + `labor cost: $${eco.labor.toFixed(4)}`);
console.log("  " + col(`verify: ${shortVerify(pro.verifyCapability)}`, W) + `verify: ${shortVerify(eco.verifyCapability)}`);
console.log("  " + col(`released ${pro.releases} · refunded ${pro.refunds}`, W) + `released ${eco.releases} · refunded ${eco.refunds}`);
const saved = pro.labor > 0 ? Math.round((1 - eco.labor / pro.labor) * 100) : 0;
console.log(
  `\n  The economy crew costs ${saved}% less labor. What you trade for it: the budget WRITER (Quill) is\n` +
    "  terser, so it cites — and pays — fewer creators; and the budget VERIFIER (Tally) checks by\n" +
    "  similarity only. On a clean source pool both tiers reach the same verdicts, so the per-run release\n" +
    "  counts above differ by writer thoroughness, not the verifier. The verifier gap is where it bites:\n" +
    "  Tally can't catch an on-topic-but-hollow citation the Auditor's LLM judge refuses — run\n" +
    "  `npm run audit-demo` for that head-to-head, with the embedding similarity printed beside each verdict.\n",
);
