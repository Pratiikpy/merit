/**
 * Balance checker — read each payer wallet's on-chain balances on Arc (no keys, pure RPC reads).
 *   npm run check-payers
 * On Arc, USDC is the native gas token (18 decimals); ERC-20 USDC (0x3600…, 6 decimals) is what Gateway/x402
 * settle in. Shows both so we know exactly what landed before depositing into Gateway.
 */
import { createPublicClient, http, defineChain, formatUnits, formatEther } from "viem";
import { readFileSync } from "node:fs";

const arc = defineChain({
  id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network"] } },
});
const USDC = "0x3600000000000000000000000000000000000000";
const ERC20 = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];
const pub = createPublicClient({ chain: arc, transport: http() });

const { payers } = JSON.parse(readFileSync(".data/payers.json", "utf8"));
console.log(`\n  Payer balances on Arc (${payers.length} wallets)\n`);
console.log("   #  address                                       native(gas)    ERC-20 USDC");
let totN = 0, totE = 0, funded = 0;
for (let i = 0; i < payers.length; i++) {
  const a = payers[i].address;
  try {
    const [nat, erc] = await Promise.all([
      pub.getBalance({ address: a }),
      pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [a] }).catch(() => 0n),
    ]);
    const n = Number(formatEther(nat)), e = Number(formatUnits(erc, 6));
    totN += n; totE += e; if (n > 0 || e > 0) funded++;
    console.log(`  ${String(i + 1).padStart(2)}  ${a}  ${n.toFixed(4).padStart(12)}  ${e.toFixed(2).padStart(12)}`);
  } catch (err) {
    console.log(`  ${String(i + 1).padStart(2)}  ${a}  read failed: ${err instanceof Error ? err.message.slice(0, 40) : err}`);
  }
}
console.log(`\n  ${funded}/${payers.length} funded · total native ${totN.toFixed(4)} · total ERC-20 USDC ${totE.toFixed(2)}\n`);
