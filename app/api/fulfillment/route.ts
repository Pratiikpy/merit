import { NextResponse } from "next/server";
import { authGate , refreshAuthFromMirror} from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { resolveSourceRef, refreshRegistryFromMirror } from "@/lib/registry";
import { effectivePrice } from "@/lib/pricing";
import { isVerifyError, verifyCitation } from "@/lib/verify/engine";
import { cardFromVerdict, refreshCardsFromMirror, saveCard } from "@/lib/cards";
import { mintFulfillment } from "@/lib/fulfillment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/fulfillment { claim, source? | sourceRef?, amount?, mandate?: { authorizer, nonce } } — the AP2
// fulfillment step. Merit verifies the delivered work and, only if it SUPPORTS the claim, mints a signed,
// offline-recoverable fulfillment credential (merit.fulfillment/v1) attesting the obligation was satisfied — the
// POST-condition a downstream AP2/x402 rail gates its next step on. A refused obligation yields no credential.
// Keyed — issuing a credential is an accountable action; pass the mandate it fulfills to bind the AP2 loop.
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: rl.status });
  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!gate.principal) return NextResponse.json({ error: "issuing a fulfillment credential requires an API key (Authorization: Bearer <key>)" }, { status: 401 });

  let body: { claim?: string; source?: string; sourceRef?: string; amount?: number; mandate?: { authorizer?: string; nonce?: string } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const claim = (body.claim || "").trim();
  if (!claim) return NextResponse.json({ error: "provide a { claim }" }, { status: 400 });

  // Resolve the delivered content: a registry source ref, or inline source text.
  let content = "";
  let sourceName: string | undefined;
  let sourceUrl: string | undefined;
  let amount = Number(body.amount) > 0 ? Number(body.amount) : 0;
  if (body.sourceRef) {
    await refreshRegistryFromMirror().catch(() => {});
    const s = resolveSourceRef(body.sourceRef);
    if (!s || !s.content) return NextResponse.json({ error: "unknown source ref" }, { status: 404 });
    content = s.content;
    sourceName = s.name;
    sourceUrl = s.url;
    if (!amount) amount = effectivePrice(s.price, s.merit, s.priceMode);
  } else if (body.source && body.source.trim()) {
    content = body.source.trim();
    sourceName = "inline source";
    if (!amount) return NextResponse.json({ error: "an inline source needs a positive { amount }" }, { status: 400 });
  } else {
    return NextResponse.json({ error: "provide a { source } or { sourceRef }" }, { status: 400 });
  }

  const mandate = body.mandate && body.mandate.authorizer && body.mandate.nonce ? { authorizer: body.mandate.authorizer, nonce: body.mandate.nonce } : undefined;

  const out = await verifyCitation(claim, content, { useNLI: true, useJudge: true });
  if (isVerifyError(out)) return NextResponse.json({ error: out.error, ...(out.numericOnly ? { numericOnly: true } : {}) }, { status: out.status });
  const v = out.verdict;
  const origin = process.env.MERIT_ORIGIN || new URL(req.url).origin;

  await refreshCardsFromMirror().catch(() => {});
  const card = saveCard(
    cardFromVerdict(v, {
      kind: v.verdict === "SUPPORTED" ? "settlement" : "verify",
      source: content,
      sourceUrl,
      sourceName,
      custody: v.verdict === "SUPPORTED",
      paidUsdc: v.verdict === "SUPPORTED" ? amount : undefined,
      createdAt: new Date().toISOString(),
    }),
  );

  // Only a passing obligation yields a credential — a refused one is honestly reported as unfulfilled.
  if (v.verdict !== "SUPPORTED") {
    return NextResponse.json({
      fulfilled: false,
      verdict: v.verdict,
      reason: v.reason,
      verificationId: v.verificationId,
      receiptUrl: `${origin}/v/${card.id}`,
      note: "The delivered work did not support the claim, so no fulfillment credential was issued.",
    });
  }

  const credential = await mintFulfillment({
    verificationId: v.verificationId!,
    claim,
    amount,
    settledAt: new Date().toISOString(),
    sourceName,
    mandate,
    receiptId: card.id,
  });

  return NextResponse.json({
    fulfilled: true,
    credential,
    receiptUrl: `${origin}/v/${card.id}`,
    note: "Signed fulfillment credential (merit.fulfillment/v1) — offline-recoverable: recover the signer from the canonical body + signature, and confirm verificationId ties to the verdict that gated the payment.",
  });
}
