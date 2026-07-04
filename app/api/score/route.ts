import { NextResponse } from "next/server";
import { authGate, refreshAuthFromMirror } from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { scoreEndpoint, listScorecards, leaderboard, getScorecard, scorecardCount, refreshScorecardsFromMirror } from "@/lib/scorecard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // pay + fetch + adversarial verify can each take seconds; don't let the default cut it off

// POST /api/score { url, claim, maxPrice? } — score ANY x402 endpoint on the one axis a payment rail can't see:
// does what it sells actually VERIFY? Merit reaches the endpoint, reads its toll terms, pays it (budget-capped,
// only for an authenticated principal that set a maxPrice), takes the delivered content, and runs it through the
// real three-gate proof-of-citation verifier — publishing a signed, shareable scorecard + a verified-quality-
// per-dollar leaderboard. Public callers get a probe/verify score (no payment); a keyed caller with maxPrice
// gets the real paid-content score. Every other agent endpoint becomes a live, verifiable data point.
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }

  let body: { url?: string; claim?: string; maxPrice?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const url = (body.url || "").trim();
  const claim = (body.claim || "").trim();
  if (!url || !claim) return NextResponse.json({ error: "provide { url, claim } — the endpoint to score and the claim its output should back" }, { status: 400 });
  if (!/^https?:\/\//i.test(url)) return NextResponse.json({ error: "url must be an absolute http(s) URL" }, { status: 400 });

  // Real payment is only ever attempted for an authenticated principal that explicitly authorized a spend
  // ceiling — a public probe never moves money. maxPrice is clamped so a stray large value can't drain the wallet.
  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  const maxPrice = Math.max(0, Math.min(0.5, Number(body.maxPrice) || 0));
  const allowPay = gate.ok && !!gate.principal && maxPrice > 0;

  await refreshScorecardsFromMirror().catch(() => {});
  const sc = await scoreEndpoint({ url, claim, maxPriceUsdc: maxPrice, allowPay });

  const origin = process.env.MERIT_ORIGIN || new URL(req.url).origin;
  return NextResponse.json({
    scorecard: sc,
    shareUrl: `${origin}/scorecard.html?id=${sc.id}`,
    paidNote: allowPay
      ? undefined
      : "Scored in probe-only mode (no payment). To pay a toll and score the PAID content, call with an API key (Authorization: Bearer <key>) and a maxPrice.",
    note: "Merit ranks endpoints by verified-quality-per-dollar — whether what they sell actually supports the claim — the dimension a price/latency/uptime directory structurally can't produce.",
  });
}

// GET /api/score           → { recent, leaderboard, count } for the public scorecard board
// GET /api/score?id=<id>   → a single scorecard (for the shareable permalink)
export async function GET(req: Request) {
  await refreshScorecardsFromMirror().catch(() => {});
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const sc = getScorecard(id);
    if (!sc) return NextResponse.json({ error: "scorecard not found" }, { status: 404 });
    return NextResponse.json({ scorecard: sc });
  }
  return NextResponse.json({
    recent: listScorecards(40),
    leaderboard: leaderboard(),
    count: scorecardCount(),
  });
}
