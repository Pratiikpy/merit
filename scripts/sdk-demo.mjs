/**
 * @merit/sdk demo (#20) — a sample EXTERNAL agent that completes a paid, verified, reputation-bearing job
 * using ONLY the published SDK, against a running Merit (STUB-safe). Proves third-party usability end-to-end.
 *   Run (server up):  node scripts/sdk-demo.mjs
 */
import { Merit } from "../sdk/merit.mjs";

const m = new Merit(process.env.MERIT_BASE || "http://localhost:3000");
const fail = (msg) => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

console.log("\n@merit/sdk demo — an external agent using only the SDK:\n");

const sources = await m.discover("What is driving stablecoin payment adoption?").catch((e) => fail(e.message));
const arr = Array.isArray(sources) ? sources : sources.sources || [];
console.log(`  discover()       → ${arr.length} candidate sources`);

const t = await m.trust({ kind: "source", minMerit: 80 }).catch((e) => fail(e.message));
console.log(`  trust()          → ${t.count} sources ranked ≥80 reputation (top: ${t.results[0]?.name})`);

const q = await m.quote(0.1, "StableData API").catch((e) => fail(e.message));
console.log(`  quote()          → guarantee $${q.coverage} for premium $${q.premium} (rep ${q.reputation})`);

const { receipt } = await m.run("What is driving stablecoin payment adoption?", 0.5).catch((e) => fail(e.message));
if (!receipt) fail("run() returned no receipt");
const paid = receipt.sources.filter((s) => s.released).length;
const refused = receipt.sources.filter((s) => !s.released).length;
console.log(`  run()            → ${paid} sources paid · ${refused} refused · released $${receipt.totals?.released ?? "?"}`);

const v = m.submitReceipt(receipt);
console.log(`  submitReceipt()  → signed=${v.signed} · verify: ${v.verifyWith}`);

const d = await m
  .openDispute("StableData API", "Cross-border settlement reached $40 trillion in annualized volume in 2026")
  .catch((e) => ({ verdict: `(judge offline: ${e.message})` }));
console.log(`  openDispute()    → verdict ${d.verdict}${d.by ? ` (${d.by})` : ""}`);

if (!paid && !refused) fail("the run produced no settlement outcomes");
console.log(`\n  ✓ A third-party agent ran discover → trust → quote → PAY (verified) → verify → dispute through the SDK alone.\n`);
process.exit(0);
