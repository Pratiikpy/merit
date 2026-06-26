/**
 * Challenge a verdict — re-audit the Auditor.
 *
 * Every other Merit verifier proves a recorded FACT from Arc (the money moved, the reputation, the
 * validation verdict, the signature). This one re-derives the Auditor's JUDGMENT itself: it re-runs the
 * proof-of-citation judge on a (source, claim) pair, independently of any settled run. A refused creator
 * can appeal; a skeptic can confirm a refusal holds. For clear-cut cases the verdict reproduces — which
 * is exactly the point: the Auditor is accountable and challengeable, not a black box.
 *
 *   Run (server up):  node scripts/challenge.mjs "<source name or id>" "<the claim it was cited for>"
 *   e.g.  node scripts/challenge.mjs "Northbridge Research" "stablecoin payment adoption scaled in 2026"
 *         node scripts/challenge.mjs "StableData API" "cross-border B2B settlement is driving adoption"
 */
const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const source = process.argv[2];
const claim = process.argv[3];
if (!source || !claim) {
  console.error('\nUsage: node scripts/challenge.mjs "<source name or id>" "<claim it was cited for>"\n');
  process.exit(1);
}

const res = await fetch(`${BASE}/api/challenge`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ source, claim }),
}).catch((e) => {
  console.error(`\n  could not reach ${BASE} — is the server up?  (${e.message})\n`);
  process.exit(1);
});
const j = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`\n  re-audit unavailable: HTTP ${res.status}${j?.error ? ` — ${j.error}` : ""}\n`);
  process.exit(1);
}

const mark = j.supported ? "✓ SUPPORTED" : "✗ REFUSED";
console.log(`\nRe-audit — the Auditor's proof-of-citation, re-run independently   (${BASE})`);
console.log(`  source:   ${j.source}`);
console.log(`  claim:    "${j.claim}"`);
console.log(`\n  verdict:  ${mark}  —  ${j.reason}`);
console.log(`\n  ${j.note}`);
console.log(`  Re-derived live, not read from a record. Challenge any verdict the same way — the Auditor is accountable.\n`);
