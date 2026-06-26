/**
 * Staking + slashing for sources (#15) — the app-side viem wrapper for contracts/src/Stake.sol (forge-tested).
 * When a STAKE_ADDRESS is configured for a deployed contract, Merit can read a source's stake (skin in the
 * game gating its listing/visibility) and the operator can SLASH a proven mis-citer's stake into a treasury.
 * Gated like reputation/escrow: inactive unless STAKE_ONCHAIN=1 + OPERATOR key + a deployed address + not
 * STUB — so the default run never depends on the contract. The OPERATOR is the contract's slasher.
 */
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, isStub } from "./arc";

const STAKE_ABI = parseAbi([
  "function slash(address source, uint256 amount, string reason)",
  "function stakeOf(address source) view returns (uint256)",
]);

export function stakeAddress(): `0x${string}` | undefined {
  const a = process.env.STAKE_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : undefined;
}

export function stakeEnabled(): boolean {
  return process.env.STAKE_ONCHAIN === "1" && !!process.env.OPERATOR_PRIVATE_KEY && !!stakeAddress() && !isStub();
}

const transport = () => http(ARC.rpcUrl);

/** A source's current stake (USDC, 6-dp atomic). Null when unconfigured/STUB. */
export async function stakeOf(source: `0x${string}`): Promise<bigint | null> {
  const addr = stakeAddress();
  if (!addr || isStub()) return null;
  try {
    return (await createPublicClient({ chain: arcTestnet, transport: transport() }).readContract({
      address: addr,
      abi: STAKE_ABI,
      functionName: "stakeOf",
      args: [source],
    })) as bigint;
  } catch (e) {
    console.error("[stake] stakeOf failed:", (e as Error).message);
    return null;
  }
}

/** Slash a proven mis-citer's stake into the treasury (the OPERATOR is the slasher). Tx hash or null. */
export async function slashSource(source: `0x${string}`, amount: bigint, reason: string): Promise<string | null> {
  if (!stakeEnabled()) return null;
  try {
    const account = privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: transport() });
    return await wallet.writeContract({
      address: stakeAddress()!,
      abi: STAKE_ABI,
      functionName: "slash",
      args: [source, amount, reason],
      account,
      chain: arcTestnet,
    });
  } catch (e) {
    console.error("[stake] slash failed:", (e as Error).message);
    return null;
  }
}
