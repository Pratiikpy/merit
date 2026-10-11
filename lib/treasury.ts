/**
 * Merit's treasury — read from the chain, not reconstructed from ledger entries.
 *
 * Every settlement this app makes (specialist hires, creator payouts, x402 toll revenue from
 * /api/verify/paid) moves through the SAME wallet: BUYER_PRIVATE_KEY both pays out (lib/pay.ts,
 * lib/custody.ts, lib/balance.ts) and receives in (verify/paid's payTo is the buyer/settlement
 * address). So the treasury is simply that wallet's live USDC balance — no P&L to reconcile, no
 * ledger entries that could drift from reality. "Source of truth beats the screen": this reads the
 * chain, same as everything else in this codebase that claims to be live.
 */
import { createPublicClient, http, getAddress } from "viem";
import { ARC, round6, arcChain } from "./arc";

const BALANCE_OF_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

function pub() {
  return createPublicClient({ chain: arcChain(), transport: http(ARC.rpcUrl) });
}

/** The treasury wallet: BUYER_ADDRESS, both the spend and the revenue side of every run. */
export function treasuryAddress(): string | null {
  const a = process.env.BUYER_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? a : null;
}

/** Live USDC balance of the treasury wallet, in human USDC. Null if unconfigured or the RPC fails —
 *  never a stale or guessed number standing in for a real one. */
export async function readTreasuryBalance(): Promise<number | null> {
  const addr = treasuryAddress();
  if (!addr) return null;
  try {
    const bal = (await pub().readContract({ address: ARC.usdc as `0x${string}`, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [getAddress(addr)] })) as bigint;
    return round6(Number(bal) / 1e6);
  } catch {
    return null;
  }
}
