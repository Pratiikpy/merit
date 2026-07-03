import { NextResponse } from "next/server";
import { authGate } from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { applyOutcome, getSources, refreshRegistryFromMirror } from "@/lib/registry";
import { rankCandidates } from "@/lib/buyer";
import { procure } from "@/lib/procure";
import { accrueCustody, refreshCustodyFromMirror } from "@/lib/custody";
import { recordSettlement } from "@/lib/history";
import { cardFromVerdict, refreshCardsFromMirror, saveCard } from "@/lib/cards";
import { round6 } from "@/lib/arc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/buy { claim, maxTry? } — the API-discovery-and-buy agent. Given a claim it needs backed, Merit ranks
// the buyable sources by VERIFIED-QUALITY-PER-DOLLAR (a signal a price/latency directory can't produce), then
// buys them in order — verifying each delivered content and PAYING ONLY the first that actually supports the
// claim, skipping (never paying for) the ones that don't. It settles the winner to its creator's custody and
// returns the comparison + how much a pay-on-delivery rail would have wasted on content that didn't verify.
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: rl.status });
  const gate = authGate(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  let body: { claim?: string; maxTry?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const claim = (body.claim || "").trim();
  if (!claim) return NextResponse.json({ error: "provide a { claim } the agent needs backed" }, { status: 400 });
  const maxTry = Math.max(1, Math.min(6, Number(body.maxTry) || 3));

  await refreshRegistryFromMirror().catch(() => {});
  const sources = getSources().filter((s) => s.content && s.content.length > 0);
  if (!sources.length) return NextResponse.json({ error: "no buyable sources are indexed yet" }, { status: 404 });
  const ranked = rankCandidates(sources); // best verified-quality-per-dollar first
  const byId = new Map(sources.map((s) => [s.id, s]));
  const origin = process.env.MERIT_ORIGIN || new URL(req.url).origin;

  const compared: Array<{ source: string; price: number; verifiedQuality: number; valuePerDollar: number; verdict: string; verificationId?: string }> = [];
  let bought: { source: string; price: number; verdict: string; verificationId?: string; receiptId: string; receiptUrl: string } | null = null;
  let wastedOnDeliveryRail = 0;

  for (const c of ranked.slice(0, maxTry)) {
    const src = byId.get(c.id);
    if (!src) continue;
    // Verify the candidate's delivered content against the claim (public probe — record:false, no reputation tank).
    const r = await procure({ content: src.content, claim, record: !!gate.principal });
    if (!r.ok) {
      compared.push({ source: c.name, price: c.price, verifiedQuality: c.verifiedQuality, valuePerDollar: c.valuePerDollar, verdict: "error" });
      continue;
    }
    compared.push({ source: c.name, price: c.price, verifiedQuality: c.verifiedQuality, valuePerDollar: c.valuePerDollar, verdict: r.verdict, verificationId: r.verdictObj.verificationId });

    if (r.verified) {
      // BUY the best-value source that actually VERIFIED — settle its price to the creator's custody (claimable
      // on-chain via domain proof), mint a signed settlement receipt, and stop (we found a correct source).
      await refreshCustodyFromMirror().catch(() => {});
      accrueCustody(src.id, src.name, c.price, src.domain ? { domain: src.domain } : undefined);
      try {
        applyOutcome(src.id, { meritDelta: 1, earned: c.price });
        recordSettlement({ runId: "buy", sourceId: src.id, cited: true, released: true, amount: c.price, confidence: r.verdictObj.score ?? 0, reason: "buy:custody", at: Date.now() });
      } catch {
        /* reputation/history update is best-effort */
      }
      await refreshCardsFromMirror().catch(() => {});
      const card = saveCard(cardFromVerdict(r.verdictObj, { kind: "settlement", source: src.content, sourceUrl: src.url, sourceName: src.name, custody: true, paidUsdc: c.price, createdAt: new Date().toISOString() }));
      bought = { source: c.name, price: c.price, verdict: r.verdict, verificationId: r.verdictObj.verificationId, receiptId: card.id, receiptUrl: `${origin}/v/${card.id}` };
      break;
    }
    // Did NOT verify — skip it, pay nothing. Track what a pay-on-delivery rail would have wasted here.
    wastedOnDeliveryRail = round6(wastedOnDeliveryRail + c.price);
  }

  const skipped = compared.filter((c) => c.verdict !== "SUPPORTED").length;
  return NextResponse.json({
    claim,
    bought,
    compared,
    triedCount: compared.length,
    skippedCount: skipped,
    wastedOnDeliveryRail, // what a rail that pays on delivery would have charged for content that didn't verify
    savings: bought
      ? `Ranked ${ranked.length} sources by verified-quality-per-dollar, verified ${compared.length}, and bought the best that VERIFIED — "${bought.source}" for $${bought.price} — skipping ${skipped} whose content did not support the claim. A pay-on-delivery rail would have wasted $${wastedOnDeliveryRail} on those.`
      : `Verified ${compared.length} candidate sources; none supported the claim, so nothing was bought. A pay-on-delivery rail would have charged $${wastedOnDeliveryRail} for content that doesn't verify.`,
    note: "Ranking uses verified quality (each source's measured citation-faithfulness) per dollar — the dimension a price/latency directory can't produce. Payment is gated on the CVO verdict, so the buyer only ever pays a source whose content actually backs the claim.",
  });
}
