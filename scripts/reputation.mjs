/**
 * Show an agent's PORTABLE REPUTATION — its full on-chain feedback track record, recomputed live
 * from Arc (decoding ReputationRegistry events), not the local merit cache. Each feedback event is
 * its own transaction, independently verifiable on arcscan. This is the proof of "reputation that
 * travels": anyone — not just Merit — can replay an agent's entire history from chain.
 *
 *   Run (server up):  node scripts/reputation.mjs [id]
 *         (no id → the highest-reputation specialist; works for any creator or specialist id)
 */
const BASE = process.env.MERIT_BASE || "http://localhost:3000";

let id = process.argv[2];
if (!id) {
  const dir = await fetch(`${BASE}/api/agents`)
    .then((r) => r.json())
    .catch(() => null);
  id = dir?.agents?.length ? [...dir.agents].sort((a, b) => b.merit - a.merit)[0].id : "auditor";
}

const res = await fetch(`${BASE}/api/reputation/${id}`);
if (!res.ok) {
  console.error(`/api/reputation/${id} → HTTP ${res.status} — is the server up at ${BASE}?`);
  process.exit(1);
}
const j = await res.json();

const kind = j.role ? `${j.kind} · ${j.role}` : j.kind || "";
console.log(`\n${j.name || id} — portable reputation${kind ? `  (${kind})` : ""}`);
console.log(`  local merit ${j.merit ?? "—"}   ·   ERC-8004 agentId ${j.agentId ?? "(none yet)"}`);

const oc = j.onchain;
if (oc && oc.feedback?.length) {
  console.log(`  recomputed from chain: ${oc.count} feedback events  ·  average score ${oc.average.toFixed(0)}\n`);
  console.log(`  Track record — each event is its own Arc tx, independently verifiable:`);
  for (const f of oc.feedback) {
    console.log(`    ${(f.score >= 0 ? "+" : "") + f.score}  ·  block ${f.block}  ·  ${f.explorerUrl}`);
  }
  console.log(`\n  This entire history is replayable from Arc by anyone — reputation that travels, not asserted.\n`);
} else {
  console.log(`  ${j.note || "no on-chain feedback yet — runs with REPUTATION_ONCHAIN=1 write it"}\n`);
}
