/**
 * Verify a Merit receipt OFFLINE — zero network, no Merit server. Reads a saved summary receipt (the JSON
 * the run emits), recovers the signer from the canonical body + signature, and asserts it equals the
 * receipt's claimed signer (the buyer wallet that paid). So "signed, self-proving receipt" is checkable in
 * five seconds by anyone, and any tampering with a verdict or amount breaks the signature.
 *   Run:  node scripts/verify-receipt.mjs <receipt.json>      (or pipe the JSON on stdin)
 */
import { readFileSync } from "node:fs";
import { recoverMessageAddress } from "viem";

// Same canonicalization as lib/receipt.ts — deterministic, recursively-sorted keys.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v)
      .sort()
      .reduce((a, k) => {
        a[k] = sortKeys(v[k]);
        return a;
      }, {});
  }
  return v;
}
const canonicalize = (v) => JSON.stringify(sortKeys(v));
const die = (m) => {
  console.error(`\n  ✗ ${m}\n`);
  process.exit(1);
};

const path = process.argv[2];
let raw;
try {
  raw = readFileSync(path || 0, "utf8");
} catch (e) {
  die(`could not read the receipt (${path || "stdin"}): ${e.message}`);
}
let receipt;
try {
  receipt = JSON.parse(raw);
} catch {
  die("the receipt is not valid JSON");
}

const { signer, signature, ...body } = receipt;
if (!signer || !signature) {
  die("this receipt is UNSIGNED (no signer/signature) — produced by a keyless STUB run. Run live (with BUYER_PRIVATE_KEY) for a signed receipt.");
}

let recovered;
try {
  recovered = await recoverMessageAddress({ message: canonicalize(body), signature });
} catch (e) {
  die(`malformed signature: ${e.message}`);
}
const ok = recovered.toLowerCase() === String(signer).toLowerCase();
// The expected payer — pass Merit's buyer address (public) to pin the signature to the wallet that
// actually paid; without it, internal consistency alone does NOT prove the payer (anyone can re-sign a
// forged receipt with their own key and set `signer` to match).
const expected = (process.argv[3] || process.env.BUYER_ADDRESS || "").trim();

console.log(`\nMerit receipt — offline signature check (no network, no Merit server):`);
console.log(`  claimed signer (buyer)   : ${signer}`);
console.log(`  recovered from signature : ${recovered}`);
console.log(`  question : ${(body.question || "").slice(0, 68)}`);
const t = body.totals || {};
console.log(`  totals   : released $${t.released ?? 0} · refunded $${t.refunded ?? 0} · labor $${t.labor ?? 0}`);

if (!ok) {
  console.log(`\n  ✗ INVALID — the signature does not match the claimed signer. The receipt was tampered with.\n`);
  process.exit(1);
}
if (expected) {
  if (recovered.toLowerCase() === expected.toLowerCase()) {
    console.log(`\n  ✓ VALID — signed by the buyer that PAID (${expected}). Every verdict and amount is`);
    console.log(`    cryptographically bound to the payer; altering any of them would break this signature.\n`);
    process.exit(0);
  }
  console.log(`\n  ✗ NOT THE PAYER — the signature is internally consistent, but the signer ${recovered}`);
  console.log(`    is NOT the expected buyer ${expected}. Do not trust these amounts.\n`);
  process.exit(1);
}
console.log(`\n  ✓ Signature is internally consistent — the body is intact and matches the self-declared signer.`);
console.log(`    To prove it was the actual PAYER, pin the buyer address (it's public, e.g. from /api/health):`);
console.log(`      npm run verify-receipt -- <receipt.json> <buyerAddress>   (or set BUYER_ADDRESS)\n`);
process.exit(0);
