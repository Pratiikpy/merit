import { NextResponse } from "next/server";
import { authGate, refreshAuthFromMirror } from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import {
  requestAdvance,
  repayAdvance,
  resolveOverdueAdvance,
  listAdvances,
  getAdvance,
  creditStats,
  creditOnchainEnabled,
  creditLimitFor,
  readStake,
  refreshCreditFromMirror,
} from "@/lib/credit";
import { getSource } from "@/lib/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Agent credit — a cash advance against a source's PROVEN verification record (merit score), real
// collateral (its on-chain Stake.sol balance), real enforcement (Stake's own slash() on default).
//
// POST /api/credit { action: "advance", sourceId, amountUsdc }        (authenticated — spends real USDC)
// POST /api/credit { action: "repay", advanceId, amountUsdc, txHash } (public — verified on-chain, never trusted)
// POST /api/credit { action: "resolve-overdue", advanceId }           (admin — real, irreversible slash)
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { action?: string; sourceId?: string; amountUsdc?: number; advanceId?: string; txHash?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = (body.action || "").trim();

  if (action === "resolve-overdue") {
    const admin = req.headers.get("x-admin-token");
    if (!admin || admin !== process.env.MERIT_ADMIN_TOKEN) return NextResponse.json({ error: "admin only" }, { status: 401 });
    if (!body.advanceId) return NextResponse.json({ error: "provide the { advanceId } to resolve" }, { status: 400 });
    const res = await resolveOverdueAdvance(body.advanceId);
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ advance: res.advance });
  }

  if (action === "repay") {
    if (!body.advanceId || !body.txHash) return NextResponse.json({ error: "provide { advanceId, amountUsdc, txHash }" }, { status: 400 });
    const res = await repayAdvance({ advanceId: body.advanceId, amountUsdc: Number(body.amountUsdc) || 0, txHash: body.txHash });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ advance: res.advance });
  }

  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  await refreshCreditFromMirror().catch(() => {});

  if (action === "advance") {
    if (!gate.ok || !gate.principal) return NextResponse.json({ error: "an advance spends real USDC from Merit's treasury — authenticate with an API key" }, { status: 401 });
    if (!body.sourceId) return NextResponse.json({ error: "provide { sourceId, amountUsdc }" }, { status: 400 });
    const res = await requestAdvance({ sourceId: body.sourceId, amountUsdc: Number(body.amountUsdc) || 0 });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ advance: res.advance, onchain: creditOnchainEnabled() });
  }

  return NextResponse.json({ error: 'provide an { action }: "advance" | "repay" | "resolve-overdue"' }, { status: 400 });
}

// GET /api/credit                    → { advances, stats, onchain }
// GET /api/credit?id=<id>            → { advance }
// GET /api/credit?sourceId=<id>      → { source: { merit, stakeUsdc, limitUsdc }, advances for that source }
export async function GET(req: Request) {
  await refreshCreditFromMirror().catch(() => {});
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const advance = getAdvance(id);
    if (!advance) return NextResponse.json({ error: "advance not found" }, { status: 404 });
    return NextResponse.json({ advance });
  }
  const sourceId = url.searchParams.get("sourceId");
  if (sourceId) {
    const source = getSource(sourceId);
    if (!source) return NextResponse.json({ error: "unknown source" }, { status: 404 });
    const stakeUsdc = await readStake(source.wallet);
    const limitUsdc = stakeUsdc === null ? null : creditLimitFor(source.merit, stakeUsdc);
    return NextResponse.json({
      source: { id: source.id, name: source.name, merit: source.merit, stakeUsdc, limitUsdc },
      advances: listAdvances(40).filter((a) => a.sourceId === sourceId),
    });
  }
  return NextResponse.json({ advances: listAdvances(40), stats: creditStats(), onchain: creditOnchainEnabled() });
}
