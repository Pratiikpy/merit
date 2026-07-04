import { NextResponse } from "next/server";
import { authGate, refreshAuthFromMirror } from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { crossChainPayout, supportedPayoutChains, gatewayBalance, recentPayouts } from "@/lib/crosschain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // a cross-chain Gateway transfer (burn + attest + mint) can take a while

// POST /api/crosschain { amount, chain, recipient } — withdraw verified earnings to another Circle Gateway chain
// (Base / Arbitrum / Optimism / Avalanche / Arc): burn from Merit's unified USDC balance on Arc, mint on the
// destination. Compliance-screened; a real payout moves money, so it requires an authenticated principal.
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }
  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!gate.principal) return NextResponse.json({ error: "a cross-chain payout requires an API key (Authorization: Bearer <key>)" }, { status: 401 });

  let body: { amount?: number; chain?: string; recipient?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.recipient) return NextResponse.json({ error: "provide { amount, chain, recipient }" }, { status: 400 });

  const res = await crossChainPayout({ amount: Number(body.amount), chain: body.chain || "", recipient: body.recipient });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({
    payout: res,
    note: `Settled ${res.amount} USDC to ${res.recipient} on ${res.label} via Circle Gateway (burned on Arc, minted on ${res.label}). These are verified earnings — money that exists only because the work passed proof-of-citation.`,
  });
}

// GET /api/crosschain → supported chains + Merit's Gateway balance + recent cross-chain payouts
export async function GET() {
  const [balance, chains] = [await gatewayBalance(), supportedPayoutChains()];
  return NextResponse.json({ chains, balance, recent: recentPayouts(30) });
}
