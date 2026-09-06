import { NextResponse, after } from "next/server";
import { isVerifyError, verifyCitation } from "@/lib/verify/engine";
import { verifyWithCache, refreshVcacheFromMirror } from "@/lib/vcache";
import { emitWebhookEvent, refreshWebhooksFromMirror } from "@/lib/webhooks";
import { extractSourceFromUrl } from "@/lib/extract";
import { cardFromVerdict, listCards, refreshCardsFromMirror, saveCard } from "@/lib/cards";
import { recordAuditVerdict, refreshAuditFromMirror } from "@/lib/audit";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { publicOrigin } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // URL fetch + NLI + adversarial judge can take several seconds

// GET /api/card?limit=N — recent public verification receipts (the shareable-card gallery / honesty feed).
export async function GET(req: Request) {
  await refreshCardsFromMirror().catch(() => {});
  const limit = Math.min(60, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 24));
  return NextResponse.json({ cards: listCards(limit) });
}

// POST /api/card { claim, source? | sourceUrl? } — the public "Verify This Claim" tool. Runs the REAL engine
// (numeric + NLI + adversarial judge), persists a shareable receipt card, and returns its permalink. Free +
// rate-limited. When given a sourceUrl, fetches + extracts the page so a user can verify against a link.
export async function POST(req: Request) {
  const gate = checkChallengeLimit(Date.now());
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "busy — try again in a moment", retryAfterMs: gate.retryMs },
      { status: gate.status, headers: { "Retry-After": String(Math.ceil((gate.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { claim?: string; source?: string; sourceUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const claim = (body.claim || "").trim();
  if (!claim) return NextResponse.json({ error: "provide a { claim } to verify" }, { status: 400 });

  let source = (body.source || "").trim();
  let sourceUrl: string | undefined;
  if (!source && body.sourceUrl) {
    const ex = await extractSourceFromUrl(body.sourceUrl.trim());
    if (!ex.ok) return NextResponse.json({ error: ex.error }, { status: 400 });
    source = ex.text;
    sourceUrl = body.sourceUrl.trim();
  }
  if (!source) {
    return NextResponse.json({ error: "provide a { source } (text) or { sourceUrl } to check the claim against" }, { status: 400 });
  }

  await refreshVcacheFromMirror().catch(() => {});
  const { outcome: out, cached } = await verifyWithCache(claim, source, () => verifyCitation(claim, source));
  if (isVerifyError(out)) {
    return NextResponse.json({ error: out.error, ...(out.numericOnly ? { numericOnly: true } : {}) }, { status: out.status });
  }
  const v = out.verdict;

  // Log to the tamper-evident audit trail ONLY on a fresh verification (a cache hit reused an already-logged
  // verdict), then persist the shareable card either way (a new permalink for the same, still-valid verdict).
  if (!cached) {
    try {
      await refreshAuditFromMirror();
      recordAuditVerdict(v, claim);
    } catch {
      /* the audit log never fails a verification */
    }
  }
  await refreshCardsFromMirror().catch(() => {});
  const card = saveCard(cardFromVerdict(v, { kind: "verify", source, sourceUrl, createdAt: new Date().toISOString() }));

  const origin = publicOrigin(req);
  const receiptUrl = `${origin}/v/${card.id}`;

  // Signed, verdict-carrying webhook — an integrator learns a citation was machine-verified SUPPORTED/REFUSED
  // and can react. Public data (same as /proof); delivered after the response so it never blocks the verify.
  after(async () => {
    await refreshWebhooksFromMirror().catch(() => {});
    await emitWebhookEvent({
      type: "citation.verified",
      at: new Date().toISOString(),
      verdict: v.verdict,
      reason: v.reason,
      claim: claim.length > 120 ? claim.slice(0, 120) + "…" : claim,
      sourceUrl: sourceUrl || null,
      receiptUrl,
      receiptId: card.id,
    });
  });

  return NextResponse.json({ id: card.id, url: receiptUrl, card, cached });
}
