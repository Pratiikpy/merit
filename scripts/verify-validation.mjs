/**
 * "Don't trust, verify" for the Auditor's VERDICT — the third ERC-8004 registry. recompute.mjs rebuilds
 * an agent's REPUTATION from chain; this proves the proof-of-citation VERDICT is on-chain and matches the
 * receipt. Given the validationTx from any run receipt, it decodes the requestHash, reads the canonical
 * ERC-8004 ValidationRegistry, and prints the recorded verdict (0-100 + tag) — with NO Merit server. So a
 * judge can independently confirm that "paid" really wrote a 100 and "refused" really wrote a 0 on-chain.
 *   Run:  node scripts/verify-validation.mjs <validationTx>   (the validationTx from a run receipt)
 */
import { createPublicClient, http, parseAbi, decodeFunctionData } from "viem";
import { arcTestnet } from "viem/chains";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const EXPLORER = "https://testnet.arcscan.app";
const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";
const ABI = parseAbi([
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
]);

const die = (e) => {
  console.error(`\n  Could not verify the validation on Arc: ${e?.message || e}\n  Check the tx hash, retry (the public RPC may be rate-limiting), or set ARC_RPC_URL.\n`);
  process.exit(1);
};
process.on("unhandledRejection", die);
process.on("uncaughtException", die);

const txHash = process.argv[2];
if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) {
  console.error("Usage: node scripts/verify-validation.mjs <validationTx>   (the 0x… validation tx from a run receipt)");
  process.exit(1);
}

const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const tx = await pub.getTransaction({ hash: txHash });
if (!tx) die("transaction not found on Arc");
if ((tx.to || "").toLowerCase() !== VALIDATION_REGISTRY.toLowerCase()) die(`tx target is not the ValidationRegistry (to=${tx.to})`);

// The requestHash is the first arg of the validationResponse call — decode it straight from the tx input.
const { functionName, args } = decodeFunctionData({ abi: ABI, data: tx.input });
if (functionName !== "validationResponse") die(`tx is a ${functionName} call, not a validationResponse`);
const requestHash = args[0];

// Read the canonical on-chain record back and show the recorded verdict.
const [validator, agentId, response, , tag] = await pub.readContract({
  address: VALIDATION_REGISTRY,
  abi: ABI,
  functionName: "getValidationStatus",
  args: [requestHash],
});

// Pin the validator to Merit's Auditor — without this anchor, ANY caller could write a self-serving
// response=100 and it would read back as "SUPPORTED by the Auditor". The Auditor = Merit's buyer wallet.
const expected = (process.env.AUDITOR_ADDRESS || process.env.BUYER_ADDRESS || "").trim();
const pinned = expected && validator.toLowerCase() === expected.toLowerCase();
if (expected && !pinned) {
  die(`validator ${validator} is NOT Merit's Auditor (${expected}) — this verdict was written by an arbitrary caller, not the proof-of-citation judge.`);
}

const verdict = response >= 100 ? "SUPPORTED — citation PAID" : Number(response) === 0 ? "REFUTED — payment REFUSED" : `partial (${response}/100)`;
console.log(`\nERC-8004 ValidationRegistry verdict — read live from Arc (no Merit server, no cache):`);
console.log(`  ValidationRegistry ${VALIDATION_REGISTRY}`);
console.log(`  validationTx        ${EXPLORER}/tx/${txHash}\n`);
console.log(`  agent ${agentId}  ·  verdict ${response}/100  →  ${verdict}`);
console.log(`  tag "${tag}"  ·  validator ${validator}  ${pinned ? "✓ pinned to Merit's Auditor" : expected ? "" : "(set AUDITOR_ADDRESS/BUYER_ADDRESS to pin this is Merit's Auditor)"}`);
console.log(`\n  The proof-of-citation verdict is recorded on-chain and independently readable: "paid" and`);
console.log(`  "refused" are not claims to trust but values to verify against the validationTx on a receipt.\n`);
