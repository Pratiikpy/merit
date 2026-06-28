import { NextResponse } from "next/server";
import { keccak256, toHex } from "viem";
import { judgeCitation, looksLikeInjection } from "@/lib/llm";
import { fabricatedFigures } from "@/lib/numcheck";
import { signReceipt } from "@/lib/receipt";
import { checkChallengeLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/verify — the Citation Verification Oracle (CVO). Given a raw (claim, source) pair from ANY agent
// (not just Merit's own runs), run Merit's deterministic numeric verifier + adversarial LLM judge and return a
// SIGNED, tamper-evident verdict an ERC-8183 settlement hook (or any payment) can consume BEFORE paying a
// citation. This is verification as a standalone product: the truth-check every reading agent needs
// underneath — including the self-report agents whose "citation" is one LLM grading its own homework. Exposed
// over HTTP and as the `verify_citation` MCP tool, so it spreads into other agents the way a question-asker
// can't: every agent that wants to NOT pay for a hallucination routes its citations through here.
export async function POST(req: Request) {
  const gate = checkChallengeLimit(Date.now());
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.status === 429 ? "rate_limited" : "busy", retryAfterMs: gate.retryMs },
      { status: gate.status, headers: { "Retry-After": String(Math.ceil((gate.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { claim?: string; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const claim = (body.claim || "").trim();
  const source = (body.source || "").trim();
  if (!claim || !source) return NextResponse.json({ error: "provide { claim, source } — both raw text" }, { status: 400 });
  if (claim.length > 4000 || source.length > 20000) return NextResponse.json({ error: "claim ≤ 4000, source ≤ 20000 chars" }, { status: 400 });
  if (looksLikeInjection(claim)) return NextResponse.json({ error: "claim rejected as a likely prompt-injection attempt" }, { status: 400 });

  // The layered verifier, identical to the run path: deterministic numeric check first, then the adversarial
  // LLM judge. The numeric layer needs no LLM, so a fabricated FIGURE is caught even in a keyless deployment.
  const fab = fabricatedFigures(claim, source);
  let verdict: "SUPPORTED" | "REFUSED";
  let by: string;
  let reasoning: string;
  if (fab.length > 0) {
    verdict = "REFUSED";
    by = "deterministic numeric verifier";
    reasoning = `The claim asserts ${fab.map((f) => f.raw).join(", ")}, which the source contradicts.`;
  } else {
    const j = await judgeCitation(claim, source);
    if (j === null) {
      return NextResponse.json(
        { error: "the adversarial LLM judge is unavailable (keyless demo) — a claim with a verifiable number is still checked deterministically; retry the judge when the key resets", numericOnly: true },
        { status: 503 },
      );
    }
    const refuted = j === "unclear" || (typeof j === "object" && j.refuted);
    verdict = refuted ? "REFUSED" : "SUPPORTED";
    by = "adversarial LLM judge";
    reasoning = (typeof j === "object" && j.reason) || (j === "unclear" ? "the source does not clearly support the claim" : "the source supports the claim");
  }

  const grounded = verdict === "SUPPORTED";
  const verdictBody = {
    schema: "merit.cvo/v1",
    claim,
    sourceHash: keccak256(toHex(source)), // bind the verdict to the exact source without echoing it
    verdict,
    grounded,
    by,
    reasoning,
    verifiedAt: new Date().toISOString(),
  };
  // Sign it with the buyer wallet so the verdict is tamper-evident + recoverable offline — a third party (or a
  // settlement hook) re-canonicalizes the body and recovers the signer; no need to trust Merit's server.
  const sig = await signReceipt(verdictBody);

  return NextResponse.json({
    ...verdictBody,
    ...(sig ?? {}),
    settlement: grounded
      ? "GROUNDED — a verification-gated payment MAY settle this citation."
      : "NOT GROUNDED — a verification-gated payment MUST REFUSE this citation. (A self-report system would pay it.)",
  });
}
