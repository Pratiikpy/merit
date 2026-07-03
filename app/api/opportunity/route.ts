import { NextResponse } from "next/server";
import { isVerifyError, verifyCitation } from "@/lib/verify/engine";
import { verifyWithCache, refreshVcacheFromMirror } from "@/lib/vcache";
import { asDepth, depthLayers, verifyDepthPrice } from "@/lib/pricing";
import { checkChallengeLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ITEMS = 8;

// POST /api/opportunity { claim, source } | { items:[{claim,source}], depth? } — a FREE ROI preflight. Runs the
// verifier (cache-accelerated, charges nothing) and shows what routing through Merit would cost vs a
// pay-on-retrieval tool: a pay-on-retrieval rail bills for ALL N citations; Merit bills only the M that verify,
// so the N−M refused ones cost $0. Lets an agent see the saving BEFORE committing to the metered/prepaid path.
export async function POST(req: Request) {
  const gate = checkChallengeLimit(Date.now());
  if (!gate.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: gate.status });

  let body: { claim?: string; source?: string; items?: Array<{ claim?: string; source?: string }>; depth?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const depth = asDepth(body.depth);
  const { useNLI, useJudge } = depthLayers(depth);
  const price = verifyDepthPrice(depth);

  const raw = body.items && Array.isArray(body.items) ? body.items : [{ claim: body.claim, source: body.source }];
  const items = raw
    .map((it) => ({ claim: (it.claim || "").trim(), source: (it.source || "").trim() }))
    .filter((it) => it.claim && it.source)
    .slice(0, MAX_ITEMS);
  if (!items.length) return NextResponse.json({ error: "provide { claim, source } or { items: [{claim, source}] }" }, { status: 400 });

  await refreshVcacheFromMirror().catch(() => {});
  const results = [];
  let verify = 0, refuse = 0, inconclusive = 0;
  for (const it of items) {
    const { outcome } = await verifyWithCache(
      `${it.claim}::${depth}`, // depth-scoped cache key so a numeric-only verdict never masquerades as a full one
      it.source,
      () => verifyCitation(it.claim, it.source, { useNLI, useJudge }),
    );
    if (isVerifyError(outcome)) {
      inconclusive++;
      results.push({ claim: it.claim.slice(0, 100), verdict: "INCONCLUSIVE", meritCharge: 0, note: outcome.error.slice(0, 100) });
    } else if (outcome.verdict.verdict === "SUPPORTED") {
      verify++;
      results.push({ claim: it.claim.slice(0, 100), verdict: "SUPPORTED", meritCharge: price });
    } else {
      refuse++;
      results.push({ claim: it.claim.slice(0, 100), verdict: "REFUSED", meritCharge: 0, note: "refused — free on Merit, paid on a retrieval rail" });
    }
  }

  const n = items.length;
  const decided = verify + refuse; // the ROI comparison is over DECIDED citations; inconclusive ones aren't billed either way
  const payOnRetrievalCost = Math.round(decided * price * 1e6) / 1e6; // a retrieval rail bills each decided citation
  const meritCost = Math.round(verify * price * 1e6) / 1e6; // Merit bills only the verified ones
  const saved = Math.round(refuse * price * 1e6) / 1e6; // meritCost + saved === payOnRetrievalCost (reconciles)
  return NextResponse.json({
    schema: "merit.opportunity/v1",
    depth,
    pricePerVerify: price,
    counts: { total: n, verified: verify, refused: refuse, inconclusive },
    payOnRetrievalCost, // over the decided citations
    meritCost,
    saved,
    savedPct: payOnRetrievalCost > 0 ? Math.round((saved / payOnRetrievalCost) * 100) : 0,
    summary:
      decided > 0
        ? `Of ${decided} decided citation${decided > 1 ? "s" : ""}, a pay-on-retrieval rail bills all ${decided}; Merit bills only the ${verify} that verified — the ${refuse} refused cost $0 (you save $${saved}).` +
          (inconclusive ? ` ${inconclusive} were inconclusive at this depth (not billed either way).` : "")
        : `No citations could be decided at depth '${depth}'${inconclusive ? ` (${inconclusive} inconclusive — try depth 'full')` : ""}.`,
    results,
  });
}
