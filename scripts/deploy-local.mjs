/**
 * Local deploy smoke (W1.5) — deploys the WHOLE Merit contract suite to an ephemeral in-memory EVM via
 * `forge script DeployAll` (a MockUSDC stands in for Arc's USDC), parses every deployed address, and writes
 * contracts/deployments.local.json. Free + offline: proves the deploy script compiles and deploys end-to-end
 * before the real, user-gated `--broadcast` to Arc testnet. No running node required — forge simulates.
 *   npm run deploy-local
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "contracts");
// Well-known anvil account #0 — used only to give the simulation a sender; never a real funded key.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const EXPECTED = [
  "MockUSDC",
  "Escrow",
  "Stake",
  "Insurance",
  "PredictionMarket",
  "AttestationVerifier",
  "MeritVerificationHook",
  "MeritJob",
];

console.log("\nLocal deploy smoke — forge simulating DeployAll (in-memory EVM, MockUSDC):\n");

let out;
try {
  out = execSync('forge script "script/Deploy.s.sol:DeployAll" -vvv', {
    cwd: root,
    env: { ...process.env, DEPLOY_MOCK_USDC: "true", PRIVATE_KEY: ANVIL_KEY },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  console.error("forge script failed:\n", e.stdout || e.stderr || e.message);
  process.exit(1);
}

// console2.log("Name:", addr) renders as "  Name: 0x…" in forge logs.
const addrs = {};
for (const line of out.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z]+):\s+(0x[0-9a-fA-F]{40})\s*$/);
  if (m) addrs[m[1]] = m[2];
}

const missing = EXPECTED.filter((k) => !addrs[k]);
if (missing.length) {
  console.error("Missing deployed addresses:", missing.join(", "));
  console.error(out);
  process.exit(1);
}

const file = path.join(root, "deployments.local.json");
writeFileSync(
  file,
  JSON.stringify(
    {
      network: "local-simulation",
      note: "forge-simulated CREATE addresses — NOT a real testnet deploy. Run DeployAll with --broadcast against arc_testnet for real addresses.",
      contracts: Object.fromEntries(EXPECTED.map((k) => [k, addrs[k]])),
    },
    null,
    2,
  ),
);

for (const k of EXPECTED) console.log(`  ${k.padEnd(22)} ${addrs[k]}`);
console.log(`\n  ✓ DeployAll simulated cleanly — all ${EXPECTED.length} contracts deployed → ${path.relative(process.cwd(), file)}\n`);
process.exit(0);
