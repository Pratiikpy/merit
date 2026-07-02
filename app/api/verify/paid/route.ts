import { NextRequest, NextResponse } from "next/server";
import { withGatewaySeller } from "@/lib/seller";
import { verifyCitation, isVerifyError } from "@/lib/verify/engine";
import { recordAuditVerdict } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // the adversarial judge call can take several seconds; don't let the default cut it off

// The metered Citation Verification Oracle (M3). Same engine + signed Verdict as the free `POST /api/verify`,
// but x402-gated: any agent — no shared secret — pays MERIT_VERIFY_PRICE USDC per call and gets the verdict.
// This is verification sold as a product: the truth-check every reading agent needs before it pays a citation,
// including the self-report agents whose "citation" is one LLM grading its own homework. The free tier stays
// open for adoption + demos (break.html, the honesty index); this is the paid, discoverable tier advertised in
// /.well-known/x402. Price is configurable (BUILD-PLAN §E default: a low per-verify fee).
const PRICE = Math.max(0.0001, Number(process.env.MERIT_VERIFY_PRICE) || 0.005);
const PAY_TO = process.env.MERIT_CVO_WALLET || process.env.BUYER_ADDRESS || "0x415Fb8814084bDBC7B6964620Ba5Be5939aD2333";

async function handler(req: NextRequest): Promise<NextResponse> {
  // Reached only AFTER the x402 payment settled (the seller wrapper gates entry) — so a paid verdict always
  // corresponds to a real settlement. Body carries the (claim, source) to check.
  let body: { claim?: string; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const out = await verifyCitation(body.claim ?? "", body.source ?? "");
  if (isVerifyError(out)) {
    return NextResponse.json({ error: out.error, ...(out.numericOnly ? { numericOnly: true } : {}) }, { status: out.status });
  }
  const v = out.verdict;
  try {
    recordAuditVerdict(v, body.claim ?? ""); // paid verdicts are logged for the compliance export too
  } catch {
    /* best-effort */
  }
  return NextResponse.json({
    ...v,
    paid: true,
    by: v.methods.join(" + "),
    settlement: v.grounded
      ? "GROUNDED — a verification-gated payment MAY settle this citation."
      : "NOT GROUNDED — a verification-gated payment MUST REFUSE this citation.",
  });
}

// x402: a request with no payment gets a 402 + requirements; a paying request settles then hits `handler`.
const sell = withGatewaySeller(handler, PRICE, "/api/verify/paid", PAY_TO, `Merit CVO — a signed citation-faithfulness verdict ($${PRICE} USDC/call)`);

export async function POST(req: NextRequest) {
  return sell(req);
}
