/**
 * Audit / compliance export pack (#3) — bundle a Merit run receipt + its verification into ONE signed,
 * regulator-ready JSON: the receipt verbatim, an offline signature check, a SHA-256 integrity digest, a
 * settlement summary (payments + refusals with their counterfactuals), and the exact server-free commands
 * that re-prove every on-chain fact. The atomic evidence object the ArcClear PRD calls the compliance moat —
 * produced and re-checkable with NO Merit server and NO trust.
 *   Run:  node scripts/audit-export.mjs <receipt.json> [buyerAddress] [out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { recoverMessageAddress } from "viem";

// Same canonicalization as lib/receipt.ts — deterministic, recursively-sorted keys.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v).sort().reduce((a, k) => ((a[k] = sortKeys(v[k])), a), {});
  }
  return v;
}
const canonicalize = (v) => JSON.stringify(sortKeys(v));
const die = (m) => {
  console.error(`\n  ✗ ${m}\n`);
  process.exit(1);
};

const path = process.argv[2];
if (!path) die("usage: audit-export.mjs <receipt.json> [buyerAddress] [out.json]");
let receipt;
try {
  receipt = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  die(`could not read/parse the receipt (${path}): ${e.message}`);
}

const { signer, signature, ...body } = receipt;
const canon = canonicalize(body);
const sha256 = createHash("sha256").update(canon).digest("hex");

// Offline signature check (same recovery as verify-receipt.mjs). A tampered receipt fails here.
let sig = { signed: false };
if (signer && signature) {
  let recovered = null;
  try {
    recovered = await recoverMessageAddress({ message: canon, signature });
  } catch (e) {
    die(`malformed signature: ${e.message}`);
  }
  if (recovered.toLowerCase() !== String(signer).toLowerCase()) {
    die(`signature does NOT match the claimed signer (${signer}) — the receipt was tampered with`);
  }
  const expected = (process.argv[3] || process.env.BUYER_ADDRESS || "").trim();
  sig = {
    signed: true,
    signer,
    recovered,
    valid: true,
    pinnedPayer: expected || null,
    isPayer: expected ? recovered.toLowerCase() === expected.toLowerCase() : null,
  };
}

const sources = Array.isArray(body.sources) ? body.sources : [];
const released = sources.filter((s) => s.released);
const refused = sources.filter((s) => !s.released);
const t = body.totals || {};

const bundle = {
  schema: "merit.audit-export/v1",
  generatedBy: "scripts/audit-export.mjs",
  integrity: { algo: "sha256", digest: sha256, canonicalBytes: canon.length },
  signature: sig,
  summary: {
    question: body.question,
    budget: body.budget,
    released: released.length,
    refused: refused.length,
    totals: { released: t.released ?? 0, refunded: t.refunded ?? 0, labor: t.labor ?? 0 },
    payments: released.map((s) => ({ name: s.name, amount: s.amount, confidence: s.confidence, tx: s.tx, onchain: s.onchain })),
    refusals: refused.map((s) => ({ name: s.name, reason: s.reason, counterfactual: s.counterfactual })),
  },
  // The server-free commands that re-prove each on-chain fact from this same receipt:
  reVerifyWith: [
    "npm run verify-receipt -- <receipt> <buyerAddress>   # the signature, offline",
    "npm run verify-all -- <receipt> <buyerAddress>        # every paid/refused decision vs the ValidationRegistry",
    "npm run verify-settlement -- <buyerWallet>            # the USDC that moved",
    "npm run recompute -- <agentId>                        # reputation rebuilt from chain",
  ],
  receipt, // the full original receipt, verbatim
};

const out = process.argv[4] || "audit-export.json";
writeFileSync(out, JSON.stringify(bundle, null, 2));

console.log(`\nMerit audit / compliance export  →  ${out}`);
console.log(`  integrity (sha256) : ${sha256.slice(0, 32)}…  (${canon.length} canonical bytes)`);
console.log(
  `  signature          : ${
    sig.signed
      ? sig.isPayer
        ? `VALID — signed by the pinned payer ${sig.pinnedPayer}`
        : sig.pinnedPayer
          ? `VALID body, but NOT the pinned payer ${sig.pinnedPayer}`
          : "valid (internally consistent — pin a buyer address to bind the payer)"
      : "UNSIGNED (keyless STUB run — run live with BUYER_PRIVATE_KEY for a signed receipt)"
  }`,
);
console.log(`  settlement         : ${released.length} paid · ${refused.length} refused · released $${t.released ?? 0} / refunded $${t.refunded ?? 0}`);
console.log(`  re-verify any claim with the server-free commands listed under reVerifyWith in the export.\n`);
process.exit(0);
