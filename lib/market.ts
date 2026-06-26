/**
 * Citation prediction market (#18) — the app side of contracts/src/PredictionMarket.sol (forge-tested). The
 * market's YES fraction is a crowd-probability that a contested citation survives appeal; `blendPrior` mixes
 * it with the Auditor's own confidence (#1) as a prior. The blend is pure (self-verifiable); stake/resolve/
 * read are gated viem against a deployed contract (inactive unless MARKET_ONCHAIN=1 + key + address + !STUB).
 */
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, isStub } from "./arc";

/** Blend the Auditor's confidence with the market's crowd probability. weight = the crowd's pull (0 = ignore
 *  the market, 1 = trust it fully). marketProbBps is 0..10000 basis points. Pure, clamped, 6-dp. */
export function blendPrior(confidence: number, marketProbBps: number, weight = 0.3): number {
  const c = Math.max(0, Math.min(1, confidence));
  const m = Math.max(0, Math.min(1, marketProbBps / 10000));
  const w = Math.max(0, Math.min(1, weight));
  return Math.round((c * (1 - w) + m * w) * 1e6) / 1e6;
}

const ABI = parseAbi([
  "function stake(bytes32 marketId, bool yes, uint256 amount)",
  "function resolve(bytes32 marketId, bool yesWon)",
  "function yesProbabilityBps(bytes32 marketId) view returns (uint256)",
]);

export function marketAddress(): `0x${string}` | undefined {
  const a = process.env.MARKET_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : undefined;
}
export function marketEnabled(): boolean {
  return process.env.MARKET_ONCHAIN === "1" && !!process.env.BUYER_PRIVATE_KEY && !!marketAddress() && !isStub();
}

const transport = () => http(ARC.rpcUrl);

/** The live crowd probability (basis points, 0..10000) that a citation survives appeal. Null if unconfigured. */
export async function yesProbabilityBps(marketId: `0x${string}`): Promise<number | null> {
  const addr = marketAddress();
  if (!addr || isStub()) return null;
  try {
    const bps = (await createPublicClient({ chain: arcTestnet, transport: transport() }).readContract({
      address: addr,
      abi: ABI,
      functionName: "yesProbabilityBps",
      args: [marketId],
    })) as bigint;
    return Number(bps);
  } catch (e) {
    console.error("[market] yesProbabilityBps failed:", (e as Error).message);
    return null;
  }
}

/** Stake YES/NO on a contested citation surviving appeal. Tx hash or null. */
export async function stakeOnMarket(marketId: `0x${string}`, yes: boolean, amount: bigint): Promise<string | null> {
  if (!marketEnabled()) return null;
  try {
    const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: transport() });
    return await wallet.writeContract({
      address: marketAddress()!,
      abi: ABI,
      functionName: "stake",
      args: [marketId, yes, amount],
      account,
      chain: arcTestnet,
    });
  } catch (e) {
    console.error("[market] stake failed:", (e as Error).message);
    return null;
  }
}
