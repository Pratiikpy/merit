import { NextResponse } from "next/server";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { simulateUsdcTransfer } from "@/lib/simulate";
import { ARC } from "@/lib/arc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/simulate — what the settlement pre-flight does. Read-only; moves no value.
export async function GET() {
  return NextResponse.json({
    schema: "merit.simulate/v1",
    what:
      "Dry-runs a USDC transfer against the Arc RPC BEFORE it is broadcast (reads the sender's balance, eth_call's " +
      "the ERC-20 transfer to see a would-revert without spending gas, checks native gas balance), so a doomed " +
      "payout is caught before it wastes gas or strands a settlement. Wired into the custodial claim.",
    posture: "A safety optimisation, not a gate: a RAN simulation predicting failure blocks the send; an inability to simulate (RPC down) does NOT block a real settlement (simulated:false, wouldSucceed:true).",
    chain: { id: ARC.chainId, usdc: ARC.usdc },
    post: "POST { to, amount, from?, token? } → { simulated, wouldSucceed, reason, balanceUsdc, hasNativeForGas, ... }",
  });
}

// POST /api/simulate { to, amount, from?, token? } — pre-flight a USDC transfer. Read-only (an eth_call + balance
// reads); rate-limited so it can't be used to hammer the RPC. `from` defaults to the custodial/buyer address.
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: rl.status });

  let body: { to?: string; amount?: number; from?: string; token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const to = (body.to || "").trim();
  const amount = Number(body.amount);
  if (!to) return NextResponse.json({ error: "provide a { to } recipient address" }, { status: 400 });
  if (!(amount > 0)) return NextResponse.json({ error: "provide a positive { amount } (USDC)" }, { status: 400 });
  const from = (body.from || process.env.CUSTODY_ADDRESS || process.env.BUYER_ADDRESS || "").trim();
  if (!from) return NextResponse.json({ error: "no sender address configured — provide { from }" }, { status: 400 });

  const result = await simulateUsdcTransfer({ from, to, amount, token: body.token });
  return NextResponse.json(result);
}
