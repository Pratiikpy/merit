/**
 * Settlement tx-simulation pre-flight (HUB-PLAN Phase 7 — enterprise readiness). Before Merit sends a real USDC
 * transfer on-chain (a custodial claim, an escrow release, any payout), it SIMULATES the transfer against the Arc
 * RPC — reads the sender's USDC balance, dry-runs the ERC-20 `transfer` via `eth_call` (so a would-revert is seen
 * without spending gas), and checks the sender holds native balance to pay gas. A payout that WOULD fail is caught
 * BEFORE it is broadcast, so it never wastes gas on a doomed transaction nor strands a settlement mid-flight.
 *
 * POSTURE (deliberately different from the compliance gate, which fails CLOSED): simulation is a SAFETY
 * OPTIMISATION, not a security gate. A simulation that RUNS and predicts failure BLOCKS the send (saves the gas);
 * an inability to simulate (STUB, RPC down, no address) does NOT block a legitimate settlement (`wouldSucceed`
 * defaults true when `simulated` is false) — refusing a real payout merely because a read-only pre-check couldn't
 * run would be worse than sending it. Every field is honest: `simulated:false` means "we could not check", never
 * "it will succeed".
 */
import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { arcTestnet } from "viem/chains";
import { ARC, isStub, round6 } from "./arc";

const ERC20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export interface SimResult {
  simulated: boolean; // did the dry-run actually execute? false = STUB / RPC unavailable / bad input → could NOT check
  wouldSucceed: boolean; // predicted outcome; defaults true when not simulated (never block on inability to check)
  reason: string;
  balanceUsdc: number | null; // sender USDC balance (human units) when read, else null
  requiredUsdc: number;
  hasNativeForGas: boolean | null; // does the sender hold native balance to pay gas? null when unread
  token: string;
  chainId: number;
  simulatedAt: string;
}

/**
 * The pure decision — separated from the RPC I/O so every branch is unit-testable without a chain. Given the read
 * facts (balance, whether the dry-run reverted, whether the sender can pay gas), decide the predicted outcome.
 * Insufficient balance or a reverting dry-run → would fail; a sender with zero native balance can't pay gas → fail.
 */
export function decideSim(facts: { balanceUsdc: number; requiredUsdc: number; reverted: boolean; hasNativeForGas: boolean }): { wouldSucceed: boolean; reason: string } {
  if (!(facts.requiredUsdc > 0)) return { wouldSucceed: false, reason: "amount must be positive" };
  if (facts.balanceUsdc + 1e-9 < facts.requiredUsdc) return { wouldSucceed: false, reason: `insufficient USDC: balance ${round6(facts.balanceUsdc)} < required ${round6(facts.requiredUsdc)}` };
  if (facts.reverted) return { wouldSucceed: false, reason: "the transfer dry-run reverted on-chain" };
  if (!facts.hasNativeForGas) return { wouldSucceed: false, reason: "sender holds no native balance to pay gas" };
  return { wouldSucceed: true, reason: "simulation passed — sufficient balance, no revert, gas payable" };
}

function isAddr(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

/**
 * Simulate a USDC transfer `from → to` for `amount`. Never throws. Returns `simulated:false, wouldSucceed:true`
 * (non-blocking) when it can't run (STUB / bad address / RPC error); returns a real predicted outcome otherwise.
 */
export async function simulateUsdcTransfer(input: { from: string; to: string; amount: number; token?: string }): Promise<SimResult> {
  const token = (input.token && isAddr(input.token) ? getAddress(input.token) : ARC.usdc) as `0x${string}`;
  const base: SimResult = {
    simulated: false,
    wouldSucceed: true, // default non-blocking — only a RAN simulation that predicts failure blocks
    reason: "",
    balanceUsdc: null,
    requiredUsdc: round6(input.amount),
    hasNativeForGas: null,
    token,
    chainId: ARC.chainId,
    simulatedAt: new Date().toISOString(),
  };
  if (!isAddr(input.from) || !isAddr(input.to)) return { ...base, reason: "from/to must be valid 0x addresses — not simulated" };
  if (!(input.amount > 0)) return { ...base, wouldSucceed: false, simulated: true, reason: "amount must be positive" };
  if (isStub()) return { ...base, reason: "STUB mode — on-chain simulation skipped (not blocking)" };

  const from = getAddress(input.from);
  const to = getAddress(input.to);
  try {
    const pub = createPublicClient({ chain: arcTestnet, transport: http(ARC.rpcUrl) });
    const atomic = BigInt(Math.round(input.amount * 1e6)); // USDC 6 decimals
    // Read the sender's USDC balance and native (gas) balance in parallel.
    const [rawBal, native] = await Promise.all([
      pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [from] }) as Promise<bigint>,
      pub.getBalance({ address: from }),
    ]);
    const balanceUsdc = Number(rawBal) / 1e6;
    const hasNativeForGas = native > BigInt(0);
    // Dry-run the transfer as `from` (eth_call — no gas, no signature). A revert (e.g. balance/allowance) throws.
    let reverted = false;
    try {
      await pub.simulateContract({ address: token, abi: ERC20, functionName: "transfer", args: [to, atomic], account: from });
    } catch {
      reverted = true;
    }
    const d = decideSim({ balanceUsdc, requiredUsdc: input.amount, reverted, hasNativeForGas });
    return { ...base, simulated: true, wouldSucceed: d.wouldSucceed, reason: d.reason, balanceUsdc: round6(balanceUsdc), hasNativeForGas };
  } catch (e) {
    // RPC unreachable / read failure → could NOT simulate. Do NOT block a real settlement on a failed pre-check.
    return { ...base, reason: `could not simulate (${(e as Error).message.slice(0, 80)}) — not blocking` };
  }
}
