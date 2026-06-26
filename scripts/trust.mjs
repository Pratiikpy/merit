/**
 * Trust-score API demo (#5) — query Merit's reputation-as-a-service: rank every counterparty an EXTERNAL
 * agent could transact with, by reputation, before it pays. The PRD's "reputation API" revenue line.
 * Server-side read, no payment.
 *   Run (server up):  node scripts/trust.mjs [kind=all|source|specialist] [minMerit]
 */
const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const kind = process.argv[2] || "all";
const minMerit = process.argv[3] || "0";

const r = await fetch(`${BASE}/api/trust?kind=${encodeURIComponent(kind)}&minMerit=${minMerit}&limit=50`);
if (!r.ok) {
  console.error(`\n  ✗ /api/trust → HTTP ${r.status} (is the server up? npm run start)\n`);
  process.exit(1);
}
const d = await r.json();
console.log(`\nMerit trust API — ${d.count} counterparties (kind=${d.query.kind}, minMerit=${d.query.minMerit}), ranked by reputation:\n`);
for (const e of d.results) {
  const tag = e.kind === "specialist" ? `${e.role}/${e.tier}` : "source";
  const rep = e.agentId ? `rep:${e.reputationUrl}` : "(no on-chain id yet)";
  console.log(`  ${String(e.merit).padStart(3)}  ${e.name.padEnd(22)} ${tag.padEnd(14)} $${e.effectivePrice}   ${rep}`);
}
console.log(`\n  ${d.note}\n`);
process.exit(0);
