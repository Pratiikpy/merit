import { NextResponse } from "next/server";
import { authGate , refreshAuthFromMirror} from "@/lib/auth";
import { initiateOfframp, offrampConfigured, offrampProvider } from "@/lib/offramp";
import { available, refreshBalanceFromMirror, releasePayoutReservation, reserveForPayout } from "@/lib/balance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function principalOr401(req: Request) {
  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  if (!gate.ok) return { error: gate.error, status: gate.status } as const;
  if (!gate.principal) return { error: "cashing out requires an API key (Authorization: Bearer <key>)", status: 401 } as const;
  return { principal: gate.principal } as const;
}

// GET /api/offramp — whether fiat cash-out is available on this deployment (and what a partner needs).
export async function GET() {
  return NextResponse.json({
    configured: offrampConfigured(),
    provider: offrampProvider() || null,
    note: offrampConfigured()
      ? "Fiat off-ramp is live — POST { amount, destination } to cash out your available (unused, funded) Merit balance to a bank."
      : "Fiat off-ramp needs a licensed partner (Circle Mint / Bridge / Coinbase). The full code path is built and settles the moment MERIT_OFFRAMP_PROVIDER + credentials are supplied.",
  });
}

// POST /api/offramp { amount, destination } — cash out the principal's OWN available Merit balance to bank fiat.
// The amount is gated on and DEBITED from the principal's available balance (reserve-before-pay, rolled back if
// the provider fails), so a cash-out can never exceed the unused, funded USDC the principal actually holds.
export async function POST(req: Request) {
  const g = await principalOr401(req);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  let body: { amount?: number; destination?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // Fiat granularity is 2dp — floor so reserve == payout == record (never over-pay a sub-cent remainder).
  const amount = Math.floor((Number(body.amount) || 0) * 100) / 100;
  const destination = (body.destination || "").trim();
  if (!(amount > 0)) return NextResponse.json({ error: "amount must be at least $0.01" }, { status: 400 });
  if (!destination) return NextResponse.json({ error: "provide a { destination } (the partner's payee/bank reference)" }, { status: 400 });

  // If no partner is wired, fail closed with what's required — WITHOUT touching the ledger (nothing to reserve).
  if (!offrampConfigured()) {
    const r = await initiateOfframp({ principalId: g.principal.id, amount, destination });
    if (r.ok) return NextResponse.json(r); // unreachable while unconfigured, but keep the type honest
    return NextResponse.json({ error: r.error, ...(r.required ? { required: r.required } : {}) }, { status: r.status });
  }

  // Gate on the principal's OWN available balance and RESERVE it atomically before broadcasting the payout.
  await refreshBalanceFromMirror().catch(() => {});
  const reserved = await reserveForPayout(g.principal.id, amount);
  if (!reserved.ok) return NextResponse.json({ error: reserved.error, available: available(g.principal.id) }, { status: reserved.status });

  const result = await initiateOfframp({ principalId: g.principal.id, amount, destination });
  if (!result.ok) {
    releasePayoutReservation(g.principal.id, amount); // provider failed → roll back; no funds left the ledger
    return NextResponse.json({ error: result.error, ...(result.required ? { required: result.required } : {}) }, { status: result.status });
  }
  return NextResponse.json({ ...result, remainingBalance: available(g.principal.id) });
}
