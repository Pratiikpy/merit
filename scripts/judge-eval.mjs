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
const BASE = process.env.MERIT_BASE || "http://localhost:3000";

// Each row: the verdict a CORRECT Auditor must return for (source, claim). Balanced; hard cases included.
const GOLD = [
  { source: "StableData API", claim: "Cross-border B2B settlement is the dominant on-chain payment flow, with enterprises using USDC to cut FX and wire costs", expect: "SUPPORTED" },
  { source: "StableData API", claim: "Settlement finality under one second removed treasury teams' last operational objection", expect: "SUPPORTED" },
  { source: "StableData API", claim: "Cross-border B2B stablecoin settlement reached $40 trillion in annualized volume in 2026", expect: "REFUSED" }, // fabricated number — content says $4.1T
  { source: "StableData API", claim: "Stablecoin adoption is driven mainly by retail meme-coin speculation", expect: "REFUSED" }, // off-topic to the source
  { source: "Chainletter Weekly", claim: "Embedded wallets drove the first real consumer stablecoin usage by provisioning USDC silently at signup", expect: "SUPPORTED" },
  { source: "Chainletter Weekly", claim: "Trading, not consumer apps, is what drove stablecoin adoption", expect: "REFUSED" }, // contradicts ("not trading")
  { source: "Dr. Lena Ortiz", claim: "Regulatory clarity from MiCA and the GENIUS Act accelerated stablecoin payment adoption", expect: "SUPPORTED" },
  { source: "Dr. Lena Ortiz", claim: "Regulation played no role in stablecoin payment adoption", expect: "REFUSED" }, // contradicts
  { source: "Ledger Lens", claim: "Sub-cent nanopayments are the fastest-growing payment primitive of 2026, enabling pay-per-call models", expect: "SUPPORTED" },
  { source: "Ledger Lens", claim: "Nanopayments remain uneconomical for amounts below thirty cents", expect: "REFUSED" }, // contradicts (card rails can't; nanopayments can)
  { source: "CryptoBuzz Daily", claim: "Enterprise treasury demand for cross-border settlement is driving stablecoin adoption", expect: "REFUSED" }, // off-topic (memecoins/astrology)
  { source: "CryptoBuzz Daily", claim: "Stablecoin payment adoption is accelerating due to regulatory clarity", expect: "REFUSED" }, // off-topic
  { source: "Anon Substack #4412", claim: "Stablecoin volume is growing because businesses want faster cross-border settlement and lower fees than banks", expect: "SUPPORTED" }, // judge checks SUPPORT only (identity is a separate gate)
  { source: "Anon Substack #4412", claim: "Stablecoin volume is growing because of high yields paid on stablecoin deposits", expect: "REFUSED" }, // not in the content
  { source: "Northbridge Research", claim: "Stablecoin payment adoption scaled strongly and is driving growth in 2026", expect: "REFUSED" }, // THE TRAP — content says it stalled
  { source: "Northbridge Research", claim: "Stablecoin payment adoption stalled in 2026, staying under $90M in annualized volume", expect: "SUPPORTED" }, // matches the trap's actual (contrarian) content
];

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
