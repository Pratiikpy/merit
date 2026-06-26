/**
 * On-chain conditional escrow (#14) — the app-side viem wrapper for contracts/src/Escrow.sol (comprehensively
 * forge-tested). When an ESCROW_ADDRESS is configured for a deployed contract, a run can LOCK USDC and then
 * RELEASE/REFUND it trustlessly, keyed to the Auditor's verdict, instead of the Gateway hold. Gated like
 * reputation: inactive unless ESCROW_ONCHAIN=1 + BUYER key + a deployed address + not STUB — so the default
 * run never depends on the contract being deployed (deploy is the user-gated activation step). In Merit the
 * BUYER agent is also the validator (it pays AND audits), so it both locks and releases/refunds.
 */
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, isStub } from "./arc";

const ESCROW_ABI = parseAbi([
  "function lock(bytes32 jobId, address payee, address validator, uint256 amount)",
  "function release(bytes32 jobId)",
  "function refund(bytes32 jobId)",
  "function stateOf(bytes32 jobId) view returns (uint8)",
]);

export function escrowAddress(): `0x${string}` | undefined {
  const a = process.env.ESCROW_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : undefined;
}

/** On-chain escrow is active only with the flag, the buyer key, a deployed address, and not in STUB. */
export function escrowEnabled(): boolean {
  return process.env.ESCROW_ONCHAIN === "1" && !!process.env.BUYER_PRIVATE_KEY && !!escrowAddress() && !isStub();
}

const transport = () => http(ARC.rpcUrl);
function buyer() {
  const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
  return { account, wallet: createWalletClient({ account, chain: arcTestnet, transport: transport() }) };
}

/** Read a job's escrow state (0=None,1=Locked,2=Released,3=Refunded,4=Disputed). Null if unconfigured/STUB. */
export async function escrowStateOf(jobId: `0x${string}`): Promise<number | null> {
  const addr = escrowAddress();
  if (!addr || isStub()) return null;
  try {
    const s = await createPublicClient({ chain: arcTestnet, transport: transport() }).readContract({
      address: addr,
      abi: ESCROW_ABI,
      functionName: "stateOf",
      args: [jobId],
    });
    return Number(s);
  } catch (e) {
    console.error("[escrow] stateOf failed:", (e as Error).message);
    return null;
  }
}

async function write(fn: "lock" | "release" | "refund", args: readonly unknown[]): Promise<string | null> {
  if (!escrowEnabled()) return null;
  try {
    const { wallet, account } = buyer();
    return await wallet.writeContract({
      address: escrowAddress()!,
      abi: ESCROW_ABI,
      functionName: fn,
      // viem validates args against the ABI at the call site; the callers below pass the right shapes.
      args: args as never,
      account,
      chain: arcTestnet,
    });
  } catch (e) {
    console.error(`[escrow] ${fn} failed:`, (e as Error).message);
    return null;
  }
}

export const escrowLock = (jobId: `0x${string}`, payee: `0x${string}`, validator: `0x${string}`, amount: bigint) =>
  write("lock", [jobId, payee, validator, amount]);
export const escrowRelease = (jobId: `0x${string}`) => write("release", [jobId]);
export const escrowRefund = (jobId: `0x${string}`) => write("refund", [jobId]);
