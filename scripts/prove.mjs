/**
 * prove — the whole run, proven honest, in one command.
 *
 * Merit's "don't trust, verify" suite proves each claim separately. This composes the two halves of
 * the proof into one verdict: (1) `verify-all` re-checks the receipt's recorded FACTS against Arc — the
 * signature (pinned to the payer), every paid/refused decision in the ValidationRegistry, the money —
 * and (2) `challenge` re-derives the Auditor's JUDGMENT live, re-running the proof-of-citation on a
 * refused-but-cited source to confirm the refusal actually holds. Facts from chain + judgment re-audited:
 * a Merit run shown honest top to bottom, from nothing but its receipt.
 *
 *   Run (server up):  node scripts/prove.mjs <receipt.json> [buyerAddress]
 *         BUYER_ADDRESS=0x… MERIT_BASE=http://localhost:3011 node scripts/prove.mjs receipt.json
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const receiptPath = process.argv[2];
const buyer = process.argv[3] || process.env.BUYER_ADDRESS || "";
if (!receiptPath) {
  console.error("\nUsage: node scripts/prove.mjs <receipt.json> [buyerAddress]\n");
  process.exit(1);
}
let receipt;
try {
  receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
} catch (e) {
  console.error(`\n  could not read receipt ${receiptPath}: ${e.message}\n`);
  process.exit(1);
}

const runChild = (cmd, args) =>
  new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("error", () => resolve({ code: 1, out }));
    c.on("close", (code) => resolve({ code, out }));
  });

console.log("\n══════  Merit — proving a run honest, top to bottom  ══════\n");

// [1] Recorded FACTS — verify-all cross-checks the receipt against Arc (signature + validation + money).
console.log("[1] FACTS  ·  verify-all re-checks the receipt against chain\n");
const vaScript = fileURLToPath(new URL("./verify-all.mjs", import.meta.url));
const va = await runChild(process.execPath, [vaScript, receiptPath, buyer].filter(Boolean));
console.log(
  va.out
    .trim()
    .split("\n")
    .map((l) => "    " + l)
    .join("\n"),
);
const factsOk = va.code === 0;

// [2] The JUDGMENT — re-audit a refused-but-cited verdict live (the one thing no chain record can prove).
console.log("\n[2] JUDGMENT  ·  challenge re-derives the Auditor's verdict live\n");
const refusedCited = (receipt.sources || []).find((s) => !s.released && s.claim);
let judgmentOk = null;
if (!refusedCited) {
  console.log("    (no cited-but-refused source in this receipt to re-audit — skipping)");
} else {
  const res = await fetch(`${BASE}/api/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: refusedCited.name, claim: refusedCited.claim }),
  }).catch(() => null);
  const j = res && res.ok ? await res.json() : null;
  if (!j) {
    console.log(`    (re-audit unavailable — no server/LLM at ${BASE}; set MERIT_BASE + the LLM key)`);
  } else {
    judgmentOk = !j.supported; // a refused source must re-audit to REFUSED for the original verdict to hold
    console.log(`    ${refusedCited.name} — cited for "${String(refusedCited.claim).slice(0, 58)}…"`);
    console.log(`    re-audit verdict:  ${j.verdict}  —  ${j.reason}`);
    console.log(`    → the refusal ${judgmentOk ? "HOLDS under independent re-audit" : "was OVERTURNED — this run owes an appeal"}`);
  }
}

console.log(`\n${"─".repeat(58)}`);
console.log(`  recorded facts (money · validation · signature):  ${factsOk ? "✓ verified from chain" : "✗ divergence — see [1]"}`);
console.log(
  `  Auditor's judgment, re-audited live:              ${
    judgmentOk === null ? "—  (no server/LLM, or no cited refusal)" : judgmentOk ? "✓ refusal holds" : "✗ overturned"
  }`,
);
const proven = factsOk && judgmentOk !== false;
console.log(`\n  ${proven ? "✓ This run is honest — facts re-checked from chain, judgment re-derived live." : "✗ Something does not reconcile — inspect above."}\n`);
process.exit(proven ? 0 : 1);
