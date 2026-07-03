import { NextResponse } from "next/server";
import { authGate, keyFromRequest } from "@/lib/auth";
import { isSessionKey } from "@/lib/session";
import { balanceStatus, creditDeposit, depositAddressFor, refreshBalanceFromMirror, simulateDeposit, withdrawBalance } from "@/lib/balance";
import { isStub } from "@/lib/arc";
import { walletSeedConfigured } from "@/lib/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // crediting a deposit / withdrawing waits on an on-chain receipt

// A prepaid balance is tied to an API-key principal — resolve it, or 401. (Auth may be OFF for the public demo,
// but a balance still needs a key to belong to; an anonymous caller has nowhere to hold one.)
function principalOr401(req: Request) {
  // A session key is verify-only — it must never reach deposit/withdraw/status here.
  if (isSessionKey(keyFromRequest(req))) return { error: "a session key can only verify (POST /api/verify/balance); use the parent API key for balance operations", status: 403 } as const;
  const gate = authGate(req);
  if (!gate.ok) return { error: gate.error, status: gate.status } as const;
  if (!gate.principal) return { error: "a prepaid balance requires an API key (Authorization: Bearer <key>)", status: 401 } as const;
  return { principal: gate.principal } as const;
}

// GET /api/balance — the principal's prepaid balance + where to deposit.
export async function GET(req: Request) {
  const g = principalOr401(req);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  await refreshBalanceFromMirror().catch(() => {});
  // Only disclose the deposit address when it's derived from a REAL seed (or in stub/demo). On a live deploy
  // without MERIT_WALLET_SEED the derived key uses the PUBLIC dev seed — so we withhold the address and say so,
  // rather than invite a deposit to an address anyone can sweep.
  const depositReady = isStub() || walletSeedConfigured();
  return NextResponse.json({
    ...balanceStatus(g.principal.id),
    depositTo: depositReady ? depositAddressFor(g.principal.id) : null,
    depositsEnabled: depositReady,
    ...(depositReady ? {} : { note: "deposits are not configured on this deployment (MERIT_WALLET_SEED unset)" }),
    asset: "USDC",
    chain: "Arc testnet 5042002",
    stub: isStub(),
  });
}

// POST /api/balance { action:"deposit", txHash } | { action:"withdraw", toWallet } — fund or cash out.
export async function POST(req: Request) {
  const g = principalOr401(req);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  let body: { action?: string; txHash?: string; toWallet?: string; amount?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  await refreshBalanceFromMirror().catch(() => {});

  if (body.action === "deposit") {
    const r = await creditDeposit(g.principal.id, (body.txHash || "").trim());
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, ...r, ...balanceStatus(g.principal.id) });
  }
  if (body.action === "withdraw") {
    const r = await withdrawBalance(g.principal.id, (body.toWallet || "").trim());
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, ...r, ...balanceStatus(g.principal.id) });
  }
  if (body.action === "deposit-sim") {
    // stub/demo only — simulateDeposit rejects on a live deploy
    const r = simulateDeposit(g.principal.id, Number(body.amount) || 0);
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, ...r, ...balanceStatus(g.principal.id) });
  }
  return NextResponse.json({ error: 'provide { action: "deposit", txHash } | { action: "withdraw", toWallet } | { action: "deposit-sim", amount } (stub only)' }, { status: 400 });
}
