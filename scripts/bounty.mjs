/**
 * Adversarial bounty arena (#8) — try to fool the Auditor into PAYING a bad citation, then read the live
 * fool-rate board. A crowdsourced, never-ending judge-eval over the moat.
 *   Run (server up):  node scripts/bounty.mjs "<source>" "<claim>"   # submit an attempt + show the board
 *                     node scripts/bounty.mjs                        # just show the board
 */
const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const source = process.argv[2];
const claim = process.argv[3];

if (source && claim) {
  const r = await fetch(`${BASE}/api/bounty`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, claim }),
  });
  const d = await r.json();
  if (!r.ok) {
    console.error(`\n  ✗ ${d.error || r.status}\n`);
    process.exit(1);
  }
  console.log(`\n  ${d.fooled ? "FOOLED" : "HELD"} — verdict ${d.verdict} (${d.by})\n  ${d.result}\n`);
}

const b = await fetch(`${BASE}/api/bounty/board`);
if (!b.ok) {
  console.error(`\n  ✗ board → HTTP ${b.status} (server up? npm run start)\n`);
  process.exit(1);
}
const board = await b.json();
const s = board.stats;
console.log(`Bounty board — ${s.total} attempts · ${s.fooled} fooled · ${s.held} held · foolRate ${(s.foolRate * 100).toFixed(1)}%\n`);
for (const e of board.recent.slice(0, 10)) {
  console.log(`  ${e.fooled ? "[FOOLED]" : "[HELD]  "} ${e.verdict.padEnd(9)} ${e.source.padEnd(20)} "${e.claim.slice(0, 50)}..."`);
}
console.log("");
process.exit(0);
