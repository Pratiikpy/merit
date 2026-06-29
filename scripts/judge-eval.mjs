/**
 * Judge the judge — measure the Auditor's OWN accuracy.
 *
 * Merit's moat is the proof-of-citation Auditor. Every other project asserts its LLM judge works; this
 * proves Merit's is CALIBRATED. It runs a hand-labeled gold set of (source, claim) pairs — half genuinely
 * supported, half mis-cited (off-topic, contradictory, a fabricated number, and the trap: on-topic but
 * contradictory) — through the LIVE Auditor (via /api/challenge), and reports accuracy / precision /
 * recall + every disagreement. Adapted from FinGPT's HaluEval harness (balanced labels, strict verdict).
 *
 * "Positive" = the Auditor correctly REFUSES a bad citation (the moat's job). A false-negative — a bad
 * citation it lets through — is a wrongful PAY, the costly error; the script exits non-zero if any occur.
 *
 *   Run (server up + LLM key):  node scripts/judge-eval.mjs
 */
import GOLD from "../lib/goldset.json" with { type: "json" };

const BASE = process.env.MERIT_BASE || "http://localhost:3000";

// The hand-labeled gold set (the verdict a CORRECT Auditor must return for each (source, claim)) is the shared
// source of truth in lib/goldset.json — the same set the public /api/honesty + /api/benchmark surfaces report,
// so the benchmark a judge reads on the site is the exact one this script scores.

async function judge(source, claim) {
  // One retry on a transient 503/429 (LLM judge busy, or the rate gate) — judge-eval is the demo's
  // measured-moat proof, so a momentary blip shouldn't leave it partial. Capped at 2 attempts so 16 pairs
  // stay under the endpoint's 40/60s global cap even if every one retries; a 4xx (bad input) won't retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${BASE}/api/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, claim }),
      });
      if (r.ok) return (await r.json()).verdict; // "SUPPORTED" | "REFUSED"
      if (r.status !== 503 && r.status !== 429) return null;
    } catch {
      /* network hiccup — fall through and retry */
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  return null;
}

console.log(`\nJudge the judge — Merit Auditor accuracy on ${GOLD.length} labeled (source, claim) pairs   (${BASE})\n`);
let tp = 0, tn = 0, fp = 0, fn = 0, errs = 0;
const misses = [];
for (const g of GOLD) {
  const got = await judge(g.source, g.claim);
  if (got == null) { errs++; console.log(`  ?  ${g.source}: judge unavailable (no server/LLM)`); continue; }
  const expectRefuse = g.expect === "REFUSED";
  const gotRefuse = got === "REFUSED";
  if (expectRefuse && gotRefuse) tp++;
  else if (!expectRefuse && !gotRefuse) tn++;
  else if (!expectRefuse && gotRefuse) { fp++; misses.push(`  ✗ over-refused  ${g.source}: "${g.claim.slice(0, 56)}…"  (gold SUPPORTED)`); }
  else { fn++; misses.push(`  ✗ MISSED (false pay)  ${g.source}: "${g.claim.slice(0, 56)}…"  (gold REFUSED)`); }
  if (got === g.expect) console.log(`  ✓  ${g.expect.padEnd(9)} ${g.source}`);
}
const n = GOLD.length - errs;
const acc = n ? (tp + tn) / n : 0;
const precision = tp + fp ? tp / (tp + fp) : 1;
const recall = tp + fn ? tp / (tp + fn) : 1;
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
console.log(misses.length ? "\n" + misses.join("\n") : "\n  No disagreements — the Auditor matched every gold label.");
console.log(`\n  accuracy ${(acc * 100).toFixed(0)}%  ·  precision ${(precision * 100).toFixed(0)}%  ·  recall ${(recall * 100).toFixed(0)}%  ·  F1 ${(f1 * 100).toFixed(0)}%   (n=${n}${errs ? `, ${errs} unavailable` : ""})`);
console.log(`  "positive" = correctly REFUSING a bad citation. A false-negative is a wrongful PAY — the error that costs money.`);
console.log(`  The moat, measured — not asserted. Extend the gold set at the top of scripts/judge-eval.mjs.\n`);
process.exit(fn > 0 ? 1 : 0); // any missed bad citation (a would-be wrongful pay) fails the eval
