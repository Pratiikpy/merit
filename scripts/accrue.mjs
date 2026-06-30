// Adaptive verified-volume driver: self-paces to the LLM rate budget. Backs off hard when a run produces no
// verified citations (throttled — strict mode refused), speeds up when releases flow. Strict mode guarantees
// every paid citation passed the judge, so this never fabricates; it just maximizes CLEAN throughput.
const BASE = process.env.MERIT_BASE || "http://localhost:3014";
const TARGET = Number(process.argv[2] || 80);            // target verified citations
const MIN = 25000, START = 45000, MAX = 480000;
let delay = START, citations = 0, settled = 0, runs = 0, throttles = 0;
const QS = [
  "What drove stablecoin payment adoption in 2026?",
  "Why did cross-border B2B settlement move on-chain?",
  "What made embedded wallets the consumer unlock for stablecoins?",
  "How did regulatory clarity affect enterprise stablecoin volume?",
  "What is the fastest-growing payment primitive of 2026?",
  "Why are nanopayments newly viable for creator monetization?",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function summary(sse) { const b = sse.split(/\n\n/); for (let i = b.length-1; i>=0; i--) if (/event:\s*summary/.test(b[i])) { const m = b[i].match(/data:\s*(\{[\s\S]*\})/); if (m) try { return JSON.parse(m[1]); } catch {} } return null; }
console.log(`accrue → ${BASE} · target ${TARGET} verified citations · adaptive pacing`);
while (citations < TARGET) {
  runs++;
  let rc = 0, rel = 0;
  try {
    const sse = await fetch(`${BASE}/api/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: QS[runs % QS.length], budget: 0.5 }) }).then((r) => r.text());
    const s = summary(sse);
    if (s?.totals) { rc = s.totals.releasedCount || 0; rel = s.totals.released || 0; }
  } catch (e) { /* network — treat as throttle */ }
  if (rc > 0) { citations += rc; settled += rel; delay = Math.max(MIN, delay - 12000); }
  else { throttles++; delay = Math.min(MAX, Math.round(delay * 1.6)); }
  console.log(`run ${runs} → +${rc} cites · total ${citations}/${TARGET} · $${settled.toFixed(4)} · ${throttles} throttled · next ${Math.round(delay/1000)}s`);
  await sleep(delay);
}
console.log(`DONE: ${citations} verified citations · $${settled.toFixed(4)} over ${runs} runs`);
