/**
 * Volume engine — drive many REAL verified jobs through Merit and write an honest TRACTION.md.
 *
 *   npm run volume <jobs> [baseUrl]          # e.g. npm run volume 50
 *
 * Each job runs the full pipeline (hire → write → proof-of-citation → settle). Every payment that moves is a
 * citation that PASSED an adversarial verifier — so this volume is verified, not self-reported. STUB=1 proves
 * the plumbing with simulated hashes (clearly labelled, NOT counted as on-chain); STUB=0 + a funded buyer
 * settles real test-USDC on Arc with tx hashes that resolve on the explorer.
 *
 * Honest by construction: the generated TRACTION.md separates this load-test volume from real external users.
 */
import { writeFileSync } from "node:fs";

const N = Math.max(1, Math.min(2000, parseInt(process.argv[2] || "10", 10)));
const base = process.argv[3] || process.env.MERIT_BASE || "http://localhost:3000";
const nowIso = process.env.RUN_AT || new Date().toISOString(); // pass RUN_AT for reproducible stamps

const QUESTIONS = [
  "What drove stablecoin payment adoption in 2026?",
  "Why did cross-border B2B settlement move on-chain?",
  "What made embedded wallets the consumer unlock for stablecoins?",
  "How did regulatory clarity affect enterprise stablecoin volume?",
  "What is the fastest-growing payment primitive of 2026?",
  "Why are nanopayments newly viable for creator monetization?",
  "What role did MiCA and the GENIUS Act play in stablecoin adoption?",
  "How did on-chain FX settlement scale in 2026?",
];

function parseSummary(sse) {
  // find the last `event: summary` block and JSON-parse its data: line
  const blocks = sse.split(/\n\n/);
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (/^event:\s*summary/m.test(blocks[i])) {
      const m = blocks[i].match(/^data:\s*(\{[\s\S]*\})\s*$/m);
      if (m) { try { return JSON.parse(m[1]); } catch { return null; } }
    }
  }
  return null;
}

let completed = 0, totalReleased = 0, totalCitations = 0;
const walletsPaid = new Set(), onchainTx = [];

console.log(`\n  Volume engine → ${base}  (${N} jobs)\n`);
for (let i = 0; i < N; i++) {
  const question = QUESTIONS[i % QUESTIONS.length];
  try {
    const res = await fetch(`${base}/api/run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, budget: 0.5 }),
    });
    const sse = await res.text();
    const s = parseSummary(sse);
    if (s?.totals) {
      completed++;
      totalReleased += s.totals.released || 0;
      for (const src of s.sources || []) {
        if (!src.released) continue;
        totalCitations++;
        walletsPaid.add(src.wallet || src.name);
        if (src.onchain && src.tx) onchainTx.push({ creator: src.name, amount: src.amount, tx: src.tx, url: src.explorerUrl });
      }
    }
  } catch (e) {
    process.stdout.write(`\n  job ${i + 1} failed: ${e instanceof Error ? e.message : e}\n`);
  }
  process.stdout.write(`\r  ${i + 1}/${N} jobs · ${totalCitations} verified citations · $${totalReleased.toFixed(4)} settled · ${walletsPaid.size} wallets paid   `);
}
console.log("\n");

const metrics = await fetch(`${base}/api/metrics`).then((r) => r.json()).catch(() => null);
const isLive = onchainTx.length > 0;
const sample = onchainTx.slice(0, 12);

const md = `# Traction

*Generated ${nowIso} by \`npm run volume ${N}\` against ${base}.*

> **Every number below is verified.** A payment only moves in Merit after the citation passes proof-of-citation
> (an adversarial LLM judge + a deterministic numeric verifier). This is settled-on-verification volume — not
> self-reported mentions.

## This run

| metric | value |
|---|---|
| jobs run | ${completed}/${N} |
| verified citations paid | ${totalCitations} |
| USDC settled | $${totalReleased.toFixed(4)} |
| distinct creator wallets paid | ${walletsPaid.size} |
| settlement mode | ${isLive ? "**real on-chain (Arc testnet)**" : "STUB — simulated hashes (NOT on-chain; run with STUB=0 + a funded buyer for real tx)"} |
${metrics?.totalSettled != null ? `| cumulative USDC settled (ledger) | $${Number(metrics.totalSettled).toFixed(4)} |\n` : ""}
${isLive ? `## On-chain settlements (sample, resolvable on the explorer)

| creator | amount | tx |
|---|---|---|
${sample.map((t) => `| ${t.creator} | $${(t.amount || 0).toFixed(6)} | [${String(t.tx).slice(0, 12)}…](${t.url || "#"}) |`).join("\n")}
` : ""}
## Methodology — honest disclosure

- **Load-test volume:** the jobs above are driven by this engine to demonstrate the system at scale and produce
  verifiable on-chain settlement. They are **our own** agent activity, disclosed as such — not external users.
- **External users:** real publishers onboarded via \`/onboard.html\` (the \`merit-verify\` owner marker proves
  it's them). *List real external creators here as they join — that is the genuine-usage signal.*

The point Merit makes that load-test volume alone cannot: **this is the only economy where the volume is gated
by verification.** Reproduce it, inspect any tx — a citation that didn't pass the verifier paid nothing.
`;

writeFileSync("TRACTION.md", md);
console.log(`  → wrote TRACTION.md  (${completed} jobs · ${totalCitations} verified citations · $${totalReleased.toFixed(4)} · ${isLive ? onchainTx.length + " on-chain tx" : "STUB/simulated"})\n`);
