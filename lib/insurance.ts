/**
 * Insurance / guarantee market (#17) — the app side of contracts/src/Insurance.sol (forge-tested). The
 * premium pricing is a pure function (the self-verifiable core); the bind/resolve/pool calls are gated viem
 * against a deployed contract (inactive unless INSURANCE_ONCHAIN=1 + key + address + not STUB).
 */
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, isStub } from "./arc";

/** Premium pricing: coverage × base rate × risk, where risk FALLS with the insured party's reputation — a
 *  high-reputation (low-risk) source is cheap to guarantee, a low-rep (high-risk) one is expensive. Pure. */
export function quotePremium(coverage: number, insuredReputation: number, baseRate = 0.05): number {
  const rep = Math.max(0, Math.min(100, insuredReputation));
  const risk = 1.2 - rep / 100; // rep 100 → 0.2× · rep 50 → 0.7× · rep 0 → 1.2×
  return Math.round(coverage * baseRate * risk * 1e6) / 1e6;
}

const ABI = parseAbi([
  "function bind(bytes32 policyId, address underwriter, uint256 premium, uint256 coverage)",
  "function resolve(bytes32 policyId, bool claimValid)",
  "function poolOf(address underwriter) view returns (uint256)",
]);

export function insuranceAddress(): `0x${string}` | undefined {
  const a = process.env.INSURANCE_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : undefined;
}
export function insuranceEnabled(): boolean {
  return process.env.INSURANCE_ONCHAIN === "1" && !!process.env.BUYER_PRIVATE_KEY && !!insuranceAddress() && !isStub();
}

const transport = () => http(ARC.rpcUrl);

export async function poolOf(underwriter: `0x${string}`): Promise<bigint | null> {
  const addr = insuranceAddress();
  if (!addr || isStub()) return null;
  try {
    return (await createPublicClient({ chain: arcTestnet, transport: transport() }).readContract({
      address: addr,
      abi: ABI,
      functionName: "poolOf",
      args: [underwriter],
    })) as bigint;
  } catch (e) {
    console.error("[insurance] poolOf failed:", (e as Error).message);
    return null;
  }
}

/** Buyer binds a guarantee policy on a job (premium → underwriter, coverage reserved). Tx hash or null. */
export async function bindPolicy(
  policyId: `0x${string}`,
  underwriter: `0x${string}`,
  premium: bigint,
  coverage: bigint,
): Promise<string | null> {
  if (!insuranceEnabled()) return null;
  try {
    const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: transport() });
    return await wallet.writeContract({
      address: insuranceAddress()!,
      abi: ABI,
      functionName: "bind",
      args: [policyId, underwriter, premium, coverage],
      account,
      chain: arcTestnet,
    });
  } catch (e) {
    console.error("[insurance] bind failed:", (e as Error).message);
    return null;
  }
}
