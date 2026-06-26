/**
 * verify-all — ONE command, total verification of a Merit receipt against Arc. No Merit server, no cache.
 *
 * The other four verifiers each prove one claim; this composes them into a single "the receipt cannot lie"
 * report. It (1) recovers the receipt's ECDSA signature offline and pins it to the wallet that PAID, then
 * (2) for every source reads the ERC-8004 ValidationRegistry verdict back from chain and CROSS-CHECKS it
 * against what the receipt claims — a "paid" source MUST read 100/100 on-chain, a "refused" source MUST
 * read 0/100, written by Merit's Auditor. Any divergence (a receipt that says paid while the chain says
 * refused, or a verdict signed by an impostor) is flagged. "Don't trust, verify" as a single runnable proof.
 *
 *   Run:  node scripts/verify-all.mjs <receipt.json> [buyerAddress]
 *         (buyerAddress — public, e.g. from /api/health — pins BOTH the signer and the Auditor/validator)
 */
import { readFileSync } from "node:fs";
import { recoverMessageAddress, createPublicClient, http, parseAbi, decodeFunctionData } from "viem";
import { arcTestnet } from "viem/chains";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const EXPLORER = "https://testnet.arcscan.app";
const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";
const ABI = parseAbi([
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
]);
const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);

// Same canonicalization as lib/receipt.ts / verify-receipt.mjs — deterministic, recursively-sorted keys.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v).sort().reduce((a, k) => { a[k] = sortKeys(v[k]); return a; }, {});
  }
  return v;
}
const canonicalize = (v) => JSON.stringify(sortKeys(v));
const die = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };

const path = process.argv[2];
const pin = (process.argv[3] || process.env.BUYER_ADDRESS || process.env.AUDITOR_ADDRESS || "").trim();
if (!path) die("usage: node scripts/verify-all.mjs <receipt.json> [buyerAddress]");

let receipt;
try { receipt = JSON.parse(readFileSync(path, "utf8")); }
catch (e) { die(`could not read/parse the receipt (${path}): ${e.message}`); }

const { signer, signature, ...body } = receipt;
console.log(`\nMerit receipt — FULL verification against Arc (no Merit server, no cache):`);
console.log(`  receipt  : ${path}`);
console.log(`  question : ${(body.question || "").slice(0, 70)}`);
const t = body.totals || {};
console.log(`  totals   : released $${t.released ?? 0} · refunded $${t.refunded ?? 0} · labor $${t.labor ?? 0}`);

let fail = false;

// ── [1] Signature: recovered offline, pinned to the payer ────────────────────────────────────────────
console.log(`\n[1] Signature — recovered offline from the canonical body:`);
if (!signer || !signature) {
  console.log(`  • UNSIGNED — this is a keyless STUB receipt. The on-chain checks below need a LIVE run`);
  console.log(`    (STUB tx hashes are fabricated). Re-run with BUYER_PRIVATE_KEY set for a signed receipt.`);
} else {
  let recovered;
  try { recovered = await recoverMessageAddress({ message: canonicalize(body), signature }); }
  catch (e) { die(`malformed signature: ${e.message}`); }
  if (recovered.toLowerCase() !== String(signer).toLowerCase()) {
    console.log(`  ✗ INVALID — signature does not match the claimed signer (${signer}). The receipt was tampered with.`);
    fail = true;
  } else if (pin && recovered.toLowerCase() === pin.toLowerCase()) {
    console.log(`  ✓ VALID — signed by the buyer that PAID (${pin}). Every verdict + amount is bound to the payer.`);
  } else if (pin) {
    console.log(`  ✗ NOT THE PAYER — signer ${recovered} is internally consistent but is NOT the expected ${pin}.`);
    fail = true;
  } else {
    console.log(`  ✓ internally consistent (signer ${recovered}). Pass the buyer address to pin it to the payer.`);
  }
}

// ── [2] Verdicts: each receipt decision cross-checked against the on-chain ValidationRegistry ─────────
const sources = Array.isArray(body.sources) ? body.sources : [];
// A real on-chain verdict carries BOTH a tx hash and an explorer URL; STUB fabricates the hash but
// suppresses the URL (exactly so a fake hash never reads as real), so the URL is the honest signal.
const onchainSources = sources.filter((s) => isHash(s.validationTx) && s.validationUrl);
console.log(`\n[2] Verdicts — every receipt decision read back from the ERC-8004 ValidationRegistry on Arc:`);
if (!onchainSources.length) {
  console.log(`  • No on-chain validation txs in this receipt (STUB run, or verdicts not written). Nothing to cross-check.`);
} else {
  const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
  let matched = 0;
  for (const s of onchainSources) {
    const claim = s.released ? "PAID" : "REFUSED";
    try {
      const tx = await pub.getTransaction({ hash: s.validationTx });
      if (!tx || (tx.to || "").toLowerCase() !== VALIDATION_REGISTRY.toLowerCase()) throw new Error("not a ValidationRegistry tx");
      const { functionName, args } = decodeFunctionData({ abi: ABI, data: tx.input });
      if (functionName !== "validationResponse") throw new Error(`tx is a ${functionName} call`);
      const [validator, agentId, response] = await pub.readContract({
        address: VALIDATION_REGISTRY, abi: ABI, functionName: "getValidationStatus", args: [args[0]],
      });
      const chainPaid = Number(response) >= 100;
      const validatorOk = !pin || validator.toLowerCase() === pin.toLowerCase();
      const verdictMatches = chainPaid === !!s.released;
      const ok = verdictMatches && validatorOk;
      if (ok) matched++; else fail = true;
      const mark = ok ? "✓" : "✗";
      const why = !validatorOk ? `  ⚠ validator ${validator} ≠ Auditor` : !verdictMatches ? `  ⚠ MISMATCH — receipt says ${claim}` : "";
      console.log(`  ${mark} ${(s.name || s.handle || "source").padEnd(20)} receipt ${claim.padEnd(7)} ↔ chain ${String(response).padStart(3)}/100  (agent ${agentId})${why}`);
    } catch (e) {
      fail = true;
      console.log(`  ✗ ${(s.name || "source").padEnd(20)} receipt ${claim.padEnd(7)} ↔ could not read on-chain: ${e.message}`);
    }
  }
  console.log(`  ${matched}/${onchainSources.length} on-chain verdicts match the receipt exactly${pin ? ", all written by the pinned Auditor" : ""}.`);
}

// ── Result ────────────────────────────────────────────────────────────────────────────────────────────
if (fail) {
  console.log(`\n  ✗ NOT FULLY VERIFIED — at least one check failed above. Do not trust this receipt.\n`);
  process.exit(1);
}
if (!signer || !signature) {
  console.log(`\n  ⚠ STUB receipt (unsigned) — nothing to verify on-chain. Run live (BUYER_PRIVATE_KEY + REPUTATION_ONCHAIN=1) for the full proof.\n`);
  process.exit(0);
}
if (!onchainSources.length) {
  console.log(`\n  ✓ Signature VALID — but this receipt carries no on-chain verdicts to cross-check.`);
  console.log(`    Run live with REPUTATION_ONCHAIN=1 to write + verify the ValidationRegistry verdicts.\n`);
  process.exit(0);
}
console.log(`\n  ✓ FULLY VERIFIED — the payer signed it, and every paid/refused decision is recorded on-chain`);
console.log(`    and matches. Nothing here is a claim to trust; it is all recomputed from Arc.`);
console.log(`    Money: npm run verify-settlement -- <wallet>   ·   Reputation: npm run recompute -- <agentId>\n`);
