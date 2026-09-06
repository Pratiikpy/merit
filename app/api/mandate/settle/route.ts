import { NextResponse } from "next/server";
import { isVerifyError, verifyCitation } from "@/lib/verify/engine";
import { verifyWithCache, refreshVcacheFromMirror } from "@/lib/vcache";
import { chargeMandate, verifyMandate, type Mandate } from "@/lib/mandate";
import { cardFromVerdict, refreshCardsFromMirror, saveCard } from "@/lib/cards";
import { recordAuditVerdict, refreshAuditFromMirror } from "@/lib/audit";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { round6 } from "@/lib/arc";
import { publicOrigin } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PRICE = Math.max(0.0001, Number(process.env.MERIT_VERIFY_PRICE) || 0.005);

// GET /api/mandate/settle — the mandate format + how to sign it (so a client can produce a valid authorization).
export async function GET() {
  return NextResponse.json({
    schema: "merit.mandate/v1",
    note: "AP2-style signed authorization as a PRECONDITION of the verify gate: a payment CLEARS to settle IFF the mandate is valid AND the citation verifies — human-authorized -> verified -> cleared. Merit clears; it does not move USDC itself.",
    mandate: { type: "citation-payment", authorizer: "0x… (the signer's address)", maxAmount: "USDC this mandate authorizes across settlements", scope: "citation", expiresAt: "epoch ms", nonce: "unique string" },
    sign: "personal_sign / EIP-191 over JSON.stringify({type, authorizer(checksummed), maxAmount, scope, expiresAt, nonce}) — same field order",
    then: "POST { claim, source, mandate, signature, amount? }",
  });
}

// POST /api/mandate/settle { claim, source, mandate, signature, amount? } — the complete signed chain. Merit
// enforces BOTH predicates: (1) the mandate is a real, in-scope, unexpired, within-cap human authorization, and
// (2) the citation VERIFIES. The payment CLEARS to settle only when both hold; a valid mandate for an unverified
// citation is refused by the gate (no juror), and a verified citation with no authorization never clears. Merit
// clears — it attests the obligation is satisfied — but does not itself move USDC (no on-chain payment claimed).
export async function POST(req: Request) {
  const gate = checkChallengeLimit(Date.now());
  if (!gate.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: gate.status });

  let body: { claim?: string; source?: string; mandate?: Mandate; signature?: string; amount?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const claim = (body.claim || "").trim();
  const source = (body.source || "").trim();
  if (!claim || !source) return NextResponse.json({ error: "provide { claim, source }" }, { status: 400 });
  if (!body.mandate || !body.signature) return NextResponse.json({ error: "provide a signed { mandate, signature } authorizing the payment" }, { status: 400 });
  const amount = round6(Number(body.amount) > 0 ? Number(body.amount) : PRICE);

  // PRECONDITION 1 — the human authorization (real signature, in scope, unexpired, within cap).
  const mv = await verifyMandate(body.mandate, body.signature, { amount, scope: "citation" });
  if (!mv.ok) return NextResponse.json({ authorized: false, settled: false, error: `mandate not valid — ${mv.reason}` }, { status: 403 });

  // PRECONDITION 2 — the verify gate.
  await refreshVcacheFromMirror().catch(() => {});
  const { outcome, cached } = await verifyWithCache(claim, source, () => verifyCitation(claim, source));
  if (isVerifyError(outcome)) return NextResponse.json({ authorized: true, settled: false, error: outcome.error, ...(outcome.numericOnly ? { numericOnly: true } : {}) }, { status: outcome.status });
  const v = outcome.verdict;

  if (!cached) {
    try {
      await refreshAuditFromMirror();
      recordAuditVerdict(v, claim);
    } catch {
      /* audit never fails a verdict */
    }
  }

  const verified = v.verdict === "SUPPORTED";

  // Both predicates held → Merit CLEARS the payment. Merit is the clearing layer: it attests the payment is
  // human-authorized AND the work verified. It does NOT itself move USDC (it holds no authorizer key), so it
  // never claims an on-chain settlement here — the actual USDC leg is the authorizer's own x402 payment, which
  // this clearance unblocks. Recording the cleared amount is ATOMIC with the cap check (chargeMandate) so
  // concurrent settles can't over-draw one signed mandate.
  let cleared = false;
  let remaining: number | undefined;
  if (verified) {
    const ch = chargeMandate(mv.authorizer, body.mandate.nonce, amount, body.mandate.maxAmount);
    if (ch.ok) {
      cleared = true;
      remaining = ch.remaining;
    } else {
      // The mandate cap was exhausted by a concurrent clearance between verifyMandate and here — refuse honestly.
      return NextResponse.json({ authorized: true, verified: true, cleared: false, error: `not cleared — ${ch.reason}` }, { status: 409 });
    }
  }

  await refreshCardsFromMirror().catch(() => {});
  // A VERIFY card (the verdict receipt) — never a settlement card with paidUsdc, because no USDC moved here.
  const card = saveCard(cardFromVerdict(v, { kind: "verify", source, createdAt: new Date().toISOString() }));
  const origin = publicOrigin(req);

  return NextResponse.json({
    authorized: true,
    verified,
    cleared,
    authorizer: mv.authorizer,
    amount: cleared ? amount : 0,
    mandateRemaining: cleared ? remaining : undefined,
    verdict: v.verdict,
    reason: v.reason,
    gates: v.gates,
    cached,
    chain: cleared
      ? "human-authorized → verified → CLEARED to settle — both predicates hold, so this payment is authorized to settle"
      : "human-authorized, but the citation did NOT verify — the gate refused it, so nothing clears (no juror needed)",
    note: "Merit is the CLEARING layer: it attests the payment is authorized AND the work verified. It does not move USDC itself — no on-chain payment is claimed here; the USDC leg is the authorizer's own payment, which this clearance unblocks.",
    receiptUrl: `${origin}/v/${card.id}`,
    receiptId: card.id,
  });
}
