/**
 * Standing autonomous Merit (W4) — the full-autonomy headline. NO human in the loop: it discovers a question,
 * runs the agent (POST /api/run SSE), records released-vs-refused, and repeats, surfacing a running
 * "autonomous earnings" tally. STUB-safe. Pair with scripts/canteen-push.mjs to report the traction.
 *   MERIT_BASE=http://localhost:3011 node scripts/daemon.mjs [cycles]
 *   Safety: DAEMON_MAX_SPEND caps cumulative spend; create a .daemon-stop file to halt (kill-switch).
 */
import { existsSync } from "node:fs";

const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const CYCLES = Math.max(1, Number(process.argv[2]) || 3);
const BUDGET = Number(process.env.DAEMON_BUDGET || 0.3);
const MAX_SPEND = Number(process.env.DAEMON_MAX_SPEND || 1.0); // hard cap on cumulative spend — the daemon stops when reached
const STOP_FILE = process.env.DAEMON_STOP_FILE || ".daemon-stop"; // create this file to halt the loop (kill-switch)

const QUESTIONS = [
  "What is driving stablecoin payment adoption in 2026?",
  "How are AI agents using nanopayments on Arc?",
  "What regulatory changes shaped stablecoin settlement this year?",
  "Why are cross-border B2B payments moving on-chain?",
];

function parseSSE(text) {
  const out = [];
  for (const frame of text.split("\n\n")) {
    let type = null,
      data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (type && data) {
      try {
        out.push({ type, data: JSON.parse(data) });
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

async function runOnce(question) {
  const res = await fetch(`${BASE}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, budget: BUDGET }),
  });
  if (!res.ok) return { released: 0, paid: 0, refused: 0, error: `HTTP ${res.status}` };
  const summary = parseSSE(await res.text()).find((e) => e.type === "summary")?.data;
  const sources = summary?.sources || [];
  const paid = sources.filter((s) => s.released).length;
  return { released: summary?.totals?.released ?? 0, paid, refused: sources.length - paid, spent: summary?.totals?.spent ?? 0 };
}

console.log(`\nStanding autonomous Merit → ${BASE} (${CYCLES} cycles, no human in the loop):\n`);
let totalReleased = 0,
  totalPaid = 0,
  totalRefused = 0,
  totalSpent = 0,
  ran = 0;
for (let i = 0; i < CYCLES; i++) {
  if (existsSync(STOP_FILE)) {
    console.log(`  ⏹ kill-switch: ${STOP_FILE} present — stopping after ${ran} cycle(s).`);
    break;
  }
  if (totalSpent >= MAX_SPEND) {
    console.log(`  ⏹ budget cap reached ($${totalSpent.toFixed(5)} ≥ $${MAX_SPEND}) — stopping after ${ran} cycle(s).`);
    break;
  }
  const q = QUESTIONS[i % QUESTIONS.length];
  const r = await runOnce(q).catch((e) => ({ error: e.message, released: 0, paid: 0, refused: 0, spent: 0 }));
  ran++;
  totalReleased += r.released || 0;
  totalPaid += r.paid || 0;
  totalRefused += r.refused || 0;
  totalSpent += r.spent || 0;
  console.log(
    `  cycle ${i + 1}: "${q.slice(0, 42)}…" → ${r.paid ?? 0} paid · ${r.refused ?? 0} refused · $${(r.released ?? 0).toFixed(5)} released · $${(r.spent ?? 0).toFixed(5)} spent${r.error ? ` (${r.error})` : ""}`,
  );
  if (i < CYCLES - 1) await new Promise((res) => setTimeout(res, 9000)); // respect the 8s run cooldown
}
console.log(
  `\n  Σ autonomous: ${totalPaid} citations paid · ${totalRefused} refused · $${totalReleased.toFixed(5)} settled · $${totalSpent.toFixed(5)} spent across ${ran} cycle(s) — earned with no human in the loop (cap $${MAX_SPEND}, kill-switch ${STOP_FILE}).\n`,
);
process.exit(0);
