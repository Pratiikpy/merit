import { NextResponse } from "next/server";
import { authGate } from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { runJury, juryRoster, refreshJuryFromMirror, refreshRepFromMirror, recentFullCertificates, JURY_SCHEMA, JURY_ENGINE, JURY_PRIOR_ART, type JuryInput } from "@/lib/jury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET /api/jury — the premium consensus-jury tier: what it is, the roster, and the economics (honest: this is a
// high-assurance premium tier, never the sub-cent default). Public read; moves no value.
export async function GET(req: Request) {
  // ?recent=1 → the most recent FULL certificates (per-ballot votes + attestation) for the public visualizer.
  if (new URL(req.url).searchParams.has("recent")) {
    await refreshJuryFromMirror().catch(() => {});
    return NextResponse.json({ certificates: recentFullCertificates(3) });
  }
  return NextResponse.json({
    schema: JURY_SCHEMA,
    engine: JURY_ENGINE,
    what:
      "A premium 4th verification tier ON TOP of the cheap cascade (numeric → NLI → single judge). Decompose an " +
      "answer into atomic claims; only the borderline claims escalate to a panel of models from DIFFERENT families " +
      "(0G DeepSeek/GLM/Qwen/MiniMax/Kimi, so errors are uncorrelated); a reputation-weighted supermajority decides " +
      "each claim; settlement is GRADED per claim (pay the claims that pass, never all-or-nothing weakest-link).",
    roster: juryRoster(),
    certificate:
      "Returns a signed merit.cvo/v3 certificate: a Merkle root over every ballot, each ballot carrying its 0G " +
      "attestation handle (the TEE-attested completion's on-chain provider address + request id + response key), so " +
      "the panel is independently checkable.",
    economics: "Cost ≈ borderline-claims × jurors (open-model calls, 1–3s each). Use it for high-value settlements, not sub-cent metering.",
    settlement: "The jury produces the GRADED settlement DECISION (gradedUsdc per claim) — a signed certificate a rail/settlement-hook releases on. The jury itself moves no USDC (like /api/mandate/settle, it clears; it does not pay).",
    priorArt: JURY_PRIOR_ART,
    keyed: "POST requires Authorization: Bearer <key> — it convenes a paid model panel (real model cost) and produces a settlement decision.",
    forcePanel: "Set forcePanel:true for the high-assurance tier — every claim the numeric floor clears goes to the full panel, bypassing the free NLI shortcut (NLI still runs and is recorded).",
    post: "POST { source, answer | claim, amount?, question?, models?, threshold?, forcePanel? }",
  });
}

// POST /api/jury { source, answer|claim, amount?, question?, models?, threshold? } — convene the panel and settle
// graded. Value-moving (settles USDC across claims + runs several paid model calls) → require an accountable
// principal EXPLICITLY, not just the global auth gate (which is relaxed on some deployments), like /api/buy.
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: rl.status });
  const gate = authGate(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!gate.principal) return NextResponse.json({ error: "the consensus jury requires an API key (Authorization: Bearer <key>) — it convenes a paid model panel and can settle value" }, { status: 401 });

  let body: JuryInput;
  try {
    body = (await req.json()) as JuryInput;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body || !body.source || !(body.answer || body.claim)) {
    return NextResponse.json({ error: "provide { source } and one of { answer | claim }" }, { status: 400 });
  }

  await Promise.all([refreshJuryFromMirror(), refreshRepFromMirror()].map((p) => p.catch(() => {})));
  const result = await runJury(body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.certificate);
}
