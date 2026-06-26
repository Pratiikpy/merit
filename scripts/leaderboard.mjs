/**
 * Merit — the reputation ECONOMY at a glance.
 *
 * `recompute` proves ONE agent's score server-free, straight from Arc. This ranks the WHOLE Merit
 * market — specialists AND creators, the two sides of the economy — by their ERC-8004 reputation,
 * so you can watch merit sort the market. The ReputationRegistry is shared chain-wide (every ERC-8004
 * project writes to it), so we scope to Merit's own roster via a running server, then show each
 * agent's on-chain score (read from Arc) next to its live local merit. Any single row is independently
 * re-derivable with `npm run recompute -- <agentId>` — no server, no cache, no trust required.
 *
 *   Run (server up):  node scripts/leaderboard.mjs
 *         MERIT_BASE=http://localhost:3011 node scripts/leaderboard.mjs
 */
const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const EXPLORER = "https://testnet.arcscan.app";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

async function getJSON(path) {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

let roster;
try {
  const [ag, sj] = await Promise.all([
    getJSON("/api/agents").catch(() => ({ agents: [] })),
    getJSON("/api/sources").catch(() => ({ sources: [] })),
  ]);
  const ids = [...new Set([...(ag.agents || []).map((a) => a.id), ...(sj.sources || []).map((s) => s.id)])];
  if (!ids.length) throw new Error("no agents or sources returned");
  roster = (await Promise.all(ids.map((id) => getJSON(`/api/reputation/${id}`).catch(() => null)))).filter(Boolean);
} catch (e) {
  console.error(`\n  Could not reach a Merit server at ${BASE} — start one (npm run start) so the roster is known.\n  (${e.message})\n`);
  process.exit(1);
}

const rows = roster
  .map((r) => {
    const oc = r.onchain && r.onchain.count ? r.onchain : null;
    const sum = oc ? oc.feedback.reduce((a, f) => a + (f.score || 0), 0) : null;
    return { name: r.name || r.id, kind: r.kind, role: r.role, merit: r.merit, agentId: r.agentId, ocAvg: oc ? oc.average : null, ocCount: oc ? oc.count : 0, ocSum: sum };
  })
  .sort((x, y) => {
    // on-chain reputation first (by average, then volume); agents with no chain feedback fall to local merit
    if ((y.ocCount > 0) !== (x.ocCount > 0)) return y.ocCount - x.ocCount > 0 ? 1 : -1;
    if (x.ocCount && y.ocCount && y.ocAvg !== x.ocAvg) return y.ocAvg - x.ocAvg;
    if (x.ocCount && y.ocCount && y.ocCount !== x.ocCount) return y.ocCount - x.ocCount;
    return (y.merit ?? 0) - (x.merit ?? 0);
  });

const onchainCount = rows.filter((r) => r.ocCount > 0).length;
console.log(`\nMerit — the reputation economy   (ERC-8004 ReputationRegistry ${REPUTATION_REGISTRY} on Arc)`);
console.log(`The two-sided market — specialists AND creators — ranked by on-chain merit, with live local merit alongside.\n`);

if (!rows.length) {
  console.log("  Roster is empty — seed it (start the server / run reset-demo), then re-run.\n");
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const sign = (n) => (n >= 0 ? "+" : "") + n;
console.log("  " + pad("#", 4) + pad("agent", 24) + pad("role", 17) + lpad("on-chain avg", 13) + lpad("events", 8) + lpad("merit", 7));
console.log("  " + "─".repeat(72));
rows.forEach((r, i) => {
  const role = r.role ? `${r.kind} · ${r.role}` : r.kind || "—";
  const oc = r.ocCount ? sign(Math.round(r.ocAvg)) : "—";
  console.log("  " + pad(i + 1, 4) + pad(String(r.name).slice(0, 23), 24) + pad(role.slice(0, 16), 17) + lpad(oc, 13) + lpad(r.ocCount || "—", 8) + lpad(r.merit ?? "—", 7));
});

console.log(`\n  ${rows.length} agents in the market · ${onchainCount} with on-chain reputation.`);
if (!onchainCount) console.log(`  (None have on-chain feedback in range yet — do a run with REPUTATION_ONCHAIN=1 to write reputation to Arc.)`);
console.log(`  Verify any single row trust-free:  npm run recompute -- <agentId>   ·   ${EXPLORER}/address/${REPUTATION_REGISTRY}\n`);
