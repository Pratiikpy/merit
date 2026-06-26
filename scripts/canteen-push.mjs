/**
 * Canteen traction push (W3) — reads Merit's live metrics (GET /api/metrics) and reports them to the
 * machine-tracked Canteen traction dashboard via the arc-canteen CLI. The 30% traction score is read from
 * here, so every real on-chain creator payment + agent settlement should be pushed. Graceful: if arc-canteen
 * isn't installed / logged in, it prints the ready-to-push summary instead.
 *   MERIT_BASE=http://localhost:3011 node scripts/canteen-push.mjs
 */
import { execSync } from "node:child_process";

const BASE = process.env.MERIT_BASE || "http://localhost:3000";

const res = await fetch(`${BASE}/api/metrics`).catch(() => null);
if (!res || !res.ok) {
  console.error(`\nmetrics unavailable at ${BASE}/api/metrics — is the server up?\n`);
  process.exit(1);
}
const m = await res.json();
const h = await fetch(`${BASE}/api/hires`)
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
const upheld = Math.round((m.calibration?.upheldRate || 0) * 100);
// Lead with the MONOTONIC on-chain total + the EXTERNAL-hire count (the unfakeable signal) — not a
// self-dealt counter. These are the numbers a wash-trading judge can't dismiss.
const summary =
  `Merit on Arc — $${(m.totalSettledUsdc || 0).toFixed(4)} settled across ${m.settlementCount || 0} on-chain settlements to ${m.distinctPayees || 0} creators` +
  (h ? ` · ${h.distinctPrincipals || 0} EXTERNAL agents hired Merit (${h.count || 0} hires)` : "") +
  ` · proof-of-citation upheld ${upheld}% on appeal`;

console.log(`\nTraction update:\n  ${summary}\n`);
try {
  execSync(`arc-canteen update-traction ${JSON.stringify(summary)}`, { stdio: "inherit", encoding: "utf-8" });
  console.log("  ✓ pushed to the Canteen.\n");
} catch {
  console.log("  (arc-canteen not logged in / unavailable — run `arc-canteen login`, then re-run to push. Summary above is ready.)\n");
}
process.exit(0);
