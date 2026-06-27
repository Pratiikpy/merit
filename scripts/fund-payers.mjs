/**
 * Fan-out funder — turn ONE funded buyer into N distinct on-chain payers, with NO extra faucet claims.
 *
 *   npm run fund-payers <count> [usdcEach] [--send]
 *
 * Generates N fresh payer wallets and (with --send, STUB=0, a funded BUYER_PRIVATE_KEY) transfers a little
 * test-USDC + native gas to each from the buyer. The keys are written to .data/payers.json (gitignored) for
 * the volume engine to rotate through as distinct payers. Without --send it DRY-RUNS — generates the wallets
 * and prints the funding plan, moving nothing — so you can review before spending.
 *
 * Why: the faucet is captcha/rate-limited and can't be scripted for 100 wallets. You don't need it — fan out
 * from the one buyer you already funded.
 */
import { createWalletClient, createPublicClient, http, parseUnits, parseEther, defineChain } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { writeFileSync, mkdirSync } from "node:fs";

const N = Math.max(1, Math.min(50, parseInt(process.argv[2] || "5", 10)));
const usdcEach = Math.max(0.01, Number(process.argv[3]) || 0.25); // test-USDC per payer
const gasEach = Number(process.env.GAS_EACH || "0.01"); // native gas per payer
const send = process.argv.includes("--send");

const arc = defineChain({
  id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network"] } },
});
const USDC = "0x3600000000000000000000000000000000000000";
const ERC20 = [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }];

// Generate the payer wallets first (always — pure, free, no chain).
const payers = Array.from({ length: N }, () => {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
});

console.log(`\n  Fan-out funder — ${N} payers · ${usdcEach} USDC + ${gasEach} gas each (from the buyer)\n`);
payers.forEach((p, i) => console.log(`  payer ${String(i + 1).padStart(2)}  ${p.address}`));

mkdirSync(".data", { recursive: true });
writeFileSync(".data/payers.json", JSON.stringify({ createdAt: process.env.RUN_AT || null, usdcEach, payers }, null, 2));
console.log(`\n  → wrote .data/payers.json (${N} keys — gitignored). Keep it private.`);

if (!send) {
  console.log(`\n  DRY-RUN — generated the wallets + plan, moved nothing. Re-run with --send (STUB=0 + a funded`);
  console.log(`  BUYER_PRIVATE_KEY) to fan out ${(usdcEach + gasEach).toFixed(2)} per payer (~${((usdcEach + gasEach) * N).toFixed(2)} total).\n`);
  process.exit(0);
}

const buyerKey = process.env.BUYER_PRIVATE_KEY;
if (!buyerKey || process.env.STUB === "1") {
  console.error("\n  --send needs STUB=0 and a funded BUYER_PRIVATE_KEY (real on-chain transfers). Aborting.\n");
  process.exit(1);
}

const account = privateKeyToAccount(buyerKey.startsWith("0x") ? buyerKey : `0x${buyerKey}`);
const wallet = createWalletClient({ account, chain: arc, transport: http() });
const pub = createPublicClient({ chain: arc, transport: http() });
console.log(`\n  funding from buyer ${account.address} …\n`);

for (let i = 0; i < payers.length; i++) {
  const p = payers[i];
  try {
    const usdcTx = await wallet.writeContract({ address: USDC, abi: ERC20, functionName: "transfer", args: [p.address, parseUnits(String(usdcEach), 6)] });
    await pub.waitForTransactionReceipt({ hash: usdcTx });
    const gasTx = await wallet.sendTransaction({ to: p.address, value: parseEther(String(gasEach)) });
    await pub.waitForTransactionReceipt({ hash: gasTx });
    console.log(`  ✓ payer ${i + 1} funded — usdc ${usdcTx.slice(0, 12)}… gas ${gasTx.slice(0, 12)}…`);
  } catch (e) {
    console.error(`  ✗ payer ${i + 1} (${p.address}) failed: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
  }
}
console.log(`\n  Done. ${N} distinct funded payers — point the volume engine at .data/payers.json to settle from each.\n`);
