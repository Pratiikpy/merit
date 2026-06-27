/**
 * Batch creator seeder — spin up many RECEIVE-ONLY creators so the volume engine has real wallets to pay.
 *
 *   npm run seed-creators <count> [baseUrl]      # e.g. npm run seed-creators 100
 *
 * Each creator gets its own wallet + an ERC-8004 identity and citable content across a topic, so a live run
 * can ground an answer in it and settle USDC. Creators are receive-only — NO faucet, no funding needed. The
 * topics mirror the volume engine's questions, so the agent actually cites + pays them under STUB=0.
 */
const N = Math.max(1, Math.min(500, parseInt(process.argv[2] || "100", 10)));
const base = process.argv[3] || process.env.MERIT_BASE || "http://localhost:3000";

// Facts the volume questions ask about — each creator paraphrases one, keeping the verifiable figure so the
// proof-of-citation verifier supports it. (Same figures as the tournament/volume facts.)
const FACTS = [
  { topic: "stablecoin payments", fig: "$4.1T", line: "Cross-border B2B stablecoin settlement crossed $4.1T in annualized volume in 2026, the dominant on-chain payment flow." },
  { topic: "embedded wallets", fig: "120 million", line: "Embedded wallets silently provisioned 120 million USDC wallets at signup in 2026, the first real consumer stablecoin usage." },
  { topic: "nanopayments", fig: "340%", line: "Sub-cent nanopayments grew 340% year over year to become the fastest-growing payment primitive of 2026." },
  { topic: "regulation", fig: "72%", line: "Regulated dollar stablecoins captured 72% of enterprise settlement volume after MiCA and the GENIUS Act gave legal comfort." },
  { topic: "on-chain FX", fig: "$880 billion", line: "On-chain FX settlement reached $880 billion in 2026 as treasuries moved off correspondent banking." },
  { topic: "adoption drivers", fig: "$4.1T", line: "Stablecoin adoption in 2026 was led by cross-border B2B settlement, which crossed $4.1T as regulatory clarity unlocked enterprise volume." },
];
const handles = ["lens", "ledger", "wire", "signal", "desk", "brief", "feed", "watch", "daily", "weekly"];

let ok = 0, failed = 0;
console.log(`\n  Seeding ${N} receive-only creators → ${base}\n`);
for (let i = 0; i < N; i++) {
  const f = FACTS[i % FACTS.length];
  const name = `${f.topic.replace(/\b\w/g, (c) => c.toUpperCase())} ${handles[i % handles.length]} #${i + 1}`;
  const content = `${f.line} Independent reporting on ${f.topic} corroborates the ${f.fig} figure.`;
  try {
    const res = await fetch(`${base}/api/creators/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, url: `https://${handles[i % handles.length]}${i + 1}.example`, content, priceMode: "merit-gated" }),
    });
    if (res.ok) ok++; else failed++;
  } catch { failed++; }
  process.stdout.write(`\r  ${i + 1}/${N} · ${ok} created · ${failed} failed   `);
}
console.log(`\n\n  ✓ ${ok} receive-only creators seeded (each its own wallet + ERC-8004 identity, zero faucet).`);
console.log(`  Next: fund a buyer, then  STUB=0 npm run volume  to settle real USDC across them.\n`);
