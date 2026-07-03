import { NextResponse, after } from "next/server";
import { isVerifyError, verifyCitation } from "@/lib/verify/engine";
import { getCard, refreshCardsFromMirror } from "@/lib/cards";
import { extractSourceFromUrl } from "@/lib/extract";
import { asDepth, depthLayers, type VerifyDepth } from "@/lib/pricing";
import { emitWebhookEvent, refreshWebhooksFromMirror } from "@/lib/webhooks";
import { checkChallengeLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/dispute { receiptId?, source?, claim?, source? } — contest a receipt WITHOUT a juror court. Merit
// resolves a dispute the only way a verification oracle can: by RE-RUNNING the deterministic verifier, at the
// SAME depth the receipt was produced at. The numeric + NLI gates reproduce byte-for-byte; the adversarial judge
// is re-run live. A contradiction UPHOLDS the dispute — no vote, no bond, no delay. Guardrails: when disputing a
// receipt, the receipt's own claim is used (a caller can't swap in a bogus claim to forge a mismatch), and an
// "UPHELD" is only declared for an AUTHORITATIVE re-check (the full source, provided or re-fetched) — never from
// the stored 600-char preview.
export async function POST(req: Request) {
  const gate = checkChallengeLimit(Date.now());
  if (!gate.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: gate.status });

  let body: { receiptId?: string; claim?: string; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let claim = (body.claim || "").trim();
  let source = (body.source || "").trim();
  let originalVerdict: "SUPPORTED" | "REFUSED" | null = null;
  let depth: VerifyDepth = "full";
  let sourceOrigin = "provided by the disputer";
  let authoritative = true; // is the source complete enough for an authoritative re-check?

  if (body.receiptId) {
    await refreshCardsFromMirror().catch(() => {});
    const card = getCard(body.receiptId.trim());
    if (!card) return NextResponse.json({ error: "receipt not found" }, { status: 404 });
    claim = card.claim; // ALWAYS the receipt's own claim — a disputer can't swap in a bogus one to forge a mismatch
    originalVerdict = card.verdict;
    depth = asDepth(card.depth); // re-verify at the SAME depth the receipt was produced at (else a shallow-tier
    // receipt would be re-run at full depth and spuriously "fail")
    if (source) {
      sourceOrigin = "full source provided by the disputer";
    } else if (card.sourceUrl) {
      const ex = await extractSourceFromUrl(card.sourceUrl);
      if (ex.ok) {
        source = ex.text;
        sourceOrigin = `re-fetched live from ${card.sourceUrl}`;
      } else {
        source = card.sourcePreview;
        sourceOrigin = "could not re-fetch the source URL — using the receipt preview (partial)";
        authoritative = false;
      }
    } else {
      source = card.sourcePreview;
      sourceOrigin = "receipt preview only — the original verdict used the full source";
      authoritative = false; // a 600-char preview is NOT enough to authoritatively contradict the original
    }
  }

  if (!claim || !source) return NextResponse.json({ error: "provide { receiptId } or { claim, source } to dispute" }, { status: 400 });

  const { useNLI, useJudge } = depthLayers(depth);
  const out = await verifyCitation(claim, source, { useNLI, useJudge });
  if (isVerifyError(out)) return NextResponse.json({ error: out.error, ...(out.numericOnly ? { numericOnly: true } : {}) }, { status: out.status });
  const v = out.verdict;

  // Agreement is only meaningful for an AUTHORITATIVE re-check at the receipt's depth. A preview-only re-check is
  // reported as indeterminate (never a false "UPHELD").
  const rawAgrees = originalVerdict === null ? null : v.verdict === originalVerdict;
  const agrees = authoritative ? rawAgrees : null;
  const upheld = agrees === false;

  if (upheld && body.receiptId) {
    after(async () => {
      await refreshWebhooksFromMirror().catch(() => {});
      await emitWebhookEvent({
        type: "citation.disputed",
        at: new Date().toISOString(),
        receiptId: body.receiptId,
        depth,
        originalVerdict,
        reverifiedVerdict: v.verdict,
        reason: v.reason,
      });
    });
  }

  return NextResponse.json({
    schema: "merit.dispute/v1",
    method: "deterministic re-verification at the receipt's own depth — no juror vote, no bond, no delay; the numeric + NLI gates reproduce byte-for-byte, the adversarial judge (when in scope) is re-run live",
    claim,
    depth,
    sourceOrigin,
    authoritative,
    original: originalVerdict,
    reverified: {
      verdict: v.verdict,
      reason: v.reason,
      gates: v.gates,
      score: v.score,
      signer: v.signer,
      signature: v.signature,
      verifiedAt: v.verifiedAt,
    },
    agrees,
    outcome:
      agrees === null
        ? authoritative
          ? "reverified (no original verdict to compare)"
          : "indeterminate — the receipt stores only a source preview; provide the full { source } for an authoritative re-check"
        : upheld
          ? "dispute UPHELD — the verdict does not reproduce at the receipt's depth; the original should not stand"
          : "dispute REJECTED — the verdict reproduces",
  });
}
