import { NextResponse } from "next/server";
import { getSource, getSources } from "@/lib/registry";
import { judgeCitation, looksLikeInjection } from "@/lib/llm";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { fabricatedFigures } from "@/lib/numcheck";
import { recordAppeal } from "@/lib/learn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/challenge  { source: <id|name>, claim: <the claim it was cited for> }
//
// Re-audit / appeal: re-run the Auditor's proof-of-citation judge on (claim, source content)
// INDEPENDENTLY of any run. Every other verifier proves a recorded FACT from chain (the money, the
// reputation, the validation verdict, the signature); this is the one that re-derives the Auditor's
// JUDGMENT itself — so a verdict isn't a black box, it's challengeable. A refused creator can appeal
// here; a skeptic can confirm a refusal holds. For clear-cut cases (the trap's contradiction, a
// genuinely supporting source) the re-audit reproduces the verdict; that reproducibility is the point.
export async function POST(req: Request) {
  // The judge IS an LLM call, so gate this endpoint by a global volume cap — otherwise it's an ungated way
  // to burn provider cost. (Global window, not per-IP: the legit judge-eval tool's 16 sequential calls must
  // not cascade-block; concurrency + provider load are already bounded by the LLM semaphore + breaker.)
  const gate = checkChallengeLimit(Date.now());
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.status === 429 ? "rate_limited" : "busy", retryAfterMs: gate.retryMs },
      { status: gate.status, headers: { "Retry-After": String(Math.ceil((gate.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { source?: string; claim?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const key = (body.source || "").trim();
  const claim = (body.claim || "").trim();
  if (!key || !claim) return NextResponse.json({ error: "provide { source, claim }" }, { status: 400 });
  if (claim.length > 2000) return NextResponse.json({ error: "claim too long (max 2000 chars)" }, { status: 400 });
  // The claim is attacker-controllable; reject obvious verdict-steering before it reaches the judge.
  if (looksLikeInjection(claim)) {
    return NextResponse.json({ error: "claim rejected as a likely prompt-injection attempt" }, { status: 400 });
  }

  const src = getSource(key) || getSources().find((s) => s.name.toLowerCase() === key.toLowerCase());
  if (!src) return NextResponse.json({ error: `no source "${key}" in the registry` }, { status: 404 });

  // Machine-verifiable first (the same layered Auditor as the run's verify path): a claim asserting a $/%
  // figure the source contradicts is a fabricated number — refuse deterministically, before the LLM. Keeps
  // the appeal consistent with settlement, and resolves this case even when the judge is throttled.
  const fabricated = fabricatedFigures(claim, src.content);
  if (fabricated.length > 0) {
    recordAppeal(src.id, false); // a machine-verified refusal is strong negative evidence (W1.3 self-improving Auditor)
    return NextResponse.json({
      source: src.name,
      claim,
      verdict: "REFUSED",
      supported: false,
      reason: `cites the figure "${fabricated[0].raw}", which the source does not support — refused (machine-verified, no LLM)`,
      judge: "deterministic numeric check — the machine-verifiable layer of proof-of-citation",
      note: "A fabricated $/% figure is caught before the LLM judge: the judge is one evidence source, not the sole proof.",
    });
  }

  const verdict = await judgeCitation(claim, src.content);
  if (verdict === null) {
    // The judge IS the LLM; with no LLM there is no re-audit to give (we never fake one).
    return NextResponse.json(
      { error: "the Auditor's LLM judge is unavailable — set the LLM key / retry to run a re-audit" },
      { status: 503 },
    );
  }
  const unclear = verdict === "unclear";
  const supported = !unclear && !verdict.refuted;
  recordAppeal(src.id, supported); // feed the independent re-audit back into the self-improving Auditor (W1.3)
  return NextResponse.json({
    source: src.name,
    claim,
    verdict: supported ? "SUPPORTED" : "REFUSED",
    supported,
    reason: unclear ? "the judge returned no clear verdict — refused (the safe default)" : verdict.reason,
    judge: "Auditor proof-of-citation LLM, re-run independently of any settled run",
    note: "Re-derives the Auditor's verdict — pay only follows SUPPORTED (plus the identity gate, checked at settle time).",
  });
}
