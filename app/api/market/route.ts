import { NextResponse } from "next/server";
import { authGate, refreshAuthFromMirror } from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { createMarket, resolveMarket, listMarkets, getMarket, marketStats, refreshMarketsFromMirror, marketOnchainEnabled } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120; // create-seed (approve+stake) or resolve (verify + oracle resolve + redeem) on-chain

// Verification-resolved prediction market — "will this claim verify?", settled by GROUND TRUTH (Merit's own
// three-gate verifier as the on-chain oracle), not a human committee. Create a market on a claim; resolve it by
// running the verifier, which resolves the pari-mutuel pool on-chain.
//
// POST /api/market { action: "create",  claim, source, seedSide?, seedUsdc? }   (seed stakes real USDC — keyed)
// POST /api/market { action: "resolve", id }
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { action?: string; claim?: string; source?: string; seedSide?: "yes" | "no"; seedUsdc?: number; id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = (body.action || "").trim();

  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  await refreshMarketsFromMirror().catch(() => {});

  if (action === "create") {
    // Seeding a real on-chain stake spends Merit USDC → only for an authenticated principal; a public create is
    // an off-chain market (probability 50/50 until seeded), still resolvable by ground truth.
    const canSeed = gate.ok && !!gate.principal;
    const res = await createMarket({ claim: body.claim || "", source: body.source || "", seedSide: canSeed ? body.seedSide : undefined, seedUsdc: canSeed ? body.seedUsdc : 0 });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    const origin = process.env.MERIT_ORIGIN || new URL(req.url).origin;
    return NextResponse.json({
      market: res.market,
      shareUrl: `${origin}/market.html?id=${res.market.id}`,
      seedNote: canSeed ? undefined : "Created off-chain (no seed stake). Connect an API key with a seedSide + seedUsdc to open a real on-chain pool.",
      onchain: marketOnchainEnabled(),
    });
  }

  if (action === "resolve") {
    if (!body.id) return NextResponse.json({ error: "provide the market { id } to resolve" }, { status: 400 });
    const res = await resolveMarket(body.id);
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ market: res.market, note: "Resolved by ground truth: Merit's three-gate verifier decided the outcome and (when on-chain) the oracle settled the pool. The signed verificationId is the verdict that resolved it." });
  }

  return NextResponse.json({ error: 'provide an { action }: "create" | "resolve"' }, { status: 400 });
}

// GET /api/market          → { markets, stats, onchain }
// GET /api/market?id=<id>  → { market }
export async function GET(req: Request) {
  await refreshMarketsFromMirror().catch(() => {});
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const market = getMarket(id);
    if (!market) return NextResponse.json({ error: "market not found" }, { status: 404 });
    return NextResponse.json({ market });
  }
  return NextResponse.json({ markets: listMarkets(40), stats: marketStats(), onchain: marketOnchainEnabled() });
}
