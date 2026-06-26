/**
 * Verify a Merit attestation OFFLINE (#19) — no server, no chain. Recovers the signer from the canonical body
 * + signature, and (given the source content) confirms sha256(content) == sourceHash — so a verdict's
 * deterministic layers (numeric fabrication + similarity-vs-threshold) are checkable independently, without
 * re-running the LLM or trusting Merit.
 *   Run:  node scripts/verify-attestation.mjs <attestation.json> [sourceContentFile]
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { recoverMessageAddress } from "viem";

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.keys(v).sort().reduce((a, k) => ((a[k] = sortKeys(v[k])), a), {});
  return v;
}
const canonicalize = (v) => JSON.stringify(sortKeys(v));
const die = (m) => {
  console.error(`\n  ✗ ${m}\n`);
  process.exit(1);
};

const path = process.argv[2];
if (!path) die("usage: verify-attestation.mjs <attestation.json> [sourceContentFile]");
let att;
try {
  att = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  die(`bad JSON: ${e.message}`);
}
const { signer, signature, ...body } = att;
if (!signer || !signature) die("attestation is UNSIGNED (keyless STUB) — run live for a signed attestation");

let recovered;
try {
  recovered = await recoverMessageAddress({ message: canonicalize(body), signature });
} catch (e) {
  die(`bad signature: ${e.message}`);
}
const sigOk = recovered.toLowerCase() === String(signer).toLowerCase();

console.log(`\nMerit attestation — offline verification (no server, no chain):`);
console.log(`  signer    : ${signer}`);
console.log(`  recovered : ${recovered}  ${sigOk ? "✓" : "✗ MISMATCH"}`);
console.log(
  `  verdict   : supported=${body.supported}  (numeric.ok=${body.numeric?.ok}, similarity ${body.similarity?.score} vs ${body.similarity?.threshold} → pass=${body.similarity?.pass})`,
);

let contentOk = null;
const contentFile = process.argv[3];
if (contentFile) {
  const content = readFileSync(contentFile, "utf8");
  const h = "0x" + createHash("sha256").update(content).digest("hex");
  contentOk = h === body.sourceHash;
  console.log(`  source    : ${contentOk ? "✓ matches the provided content" : "✗ content does NOT match sourceHash"}`);
}

if (!sigOk) die("signature does not match the signer — tampered");
if (contentOk === false) die("the source content does not match the attestation's hash");
console.log(
  `\n  ✓ Attestation verified — the deterministic verdict is signed${contentFile ? " and binds the provided source." : " (pass a source file to bind the content)."}\n`,
);
process.exit(0);
