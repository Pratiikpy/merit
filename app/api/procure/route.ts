import { NextResponse } from "next/server";
import { authGate , refreshAuthFromMirror} from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { procure } from "@/lib/procure";
import { cardFromVerdict, refreshCardsFromMirror, saveCard } from "@/lib/cards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/procure { url? , content?, claim } — "verify the work, not just pay for it," for outbound buys.
// Merit checks that what an external seller DELIVERED (a page it fetches, or content already delivered) actually
// supports the claim it was procured for, records the seller's delivery outcome (feeding the reputation firewall),
// mints a shareable receipt, and returns the verdict. A firewalled seller is refused before any fetch/pay.
export async function POST(req: Request) {
  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: rl.status });

  let body: { url?: string; content?: string; claim?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Only an accountable, KEYED principal's procurement moves seller reputation — an anonymous probe gets the
  // verification but can't tank a seller's standing (prevents an unauthenticated reputation-DoS).
  const result = await procure({ url: body.url, content: body.content, claim: body.claim || "", record: !!gate.principal });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, ...(result.host ? { host: result.host } : {}), ...(result.blocked ? { blocked: true } : {}) }, { status: result.status });
  }

  await refreshCardsFromMirror().catch(() => {});
  const card = saveCard(cardFromVerdict(result.verdictObj, { kind: "verify", source: result.content, sourceUrl: body.url, sourceName: result.host, createdAt: new Date().toISOString() }));
  const origin = process.env.MERIT_ORIGIN || new URL(req.url).origin;

  return NextResponse.json({
    host: result.host,
    verified: result.verified,
    verdict: result.verdict,
    reason: result.reason,
    gates: result.gates,
    sellerScore: result.sellerScore, // this seller's verified-delivery rate (0.5 = neutral)
    cached: result.cached,
    delivery: result.verified
      ? "the seller delivered content that verifies the claim"
      : "the seller delivered content that does NOT support the claim — this counts against its reputation and can firewall it",
    contentPreview: result.contentPreview,
    receiptUrl: `${origin}/v/${card.id}`,
    receiptId: card.id,
  });
}
