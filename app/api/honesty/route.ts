import { NextResponse } from "next/server";
import { bountyStats } from "@/lib/bounty";
import { benchStats } from "@/lib/bench";
import { goldSummary } from "@/lib/goldset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/honesty — the Citation Honesty Index (CHI). A verification STANDARD, not a trust score: an agent
// earns a grounding rate only by routing its citations through Merit's Citation Verification Oracle
// (verify_citation / POST /api/verify). Merit's own verified integrity is the reference row, built from live
// data: every adversarial attack the verifier held, and the benchmark it grows from. An agent whose "citation"
// is one LLM self-reporting which sources it used has NO independent grounding rate — there is nothing to
// score until it routes through the CVO. The trap, stated neutrally: verify here, or you simply aren't ranked.
export async function GET() {
  const b = bountyStats();
  const bench = benchStats();
  const g = goldSummary();
  // The verified row = the reproducible benchmark baseline (the published gold set, scored by `npm run
  // judge-eval`) PLUS any live adversarial attempts from /api/bounty. So the counters are real and non-zero
  // even on a fresh deploy, and they only grow as the open bounty is attacked.
  const adversarialAttacks = g.adversarial + b.total;
  const attacksHeld = g.attacksHeld + b.held;
  return NextResponse.json({
    schema: "merit.chi/v1",
    standard:
      "A citation is GROUNDED only if it passes an adversarial LLM judge + a deterministic numeric verifier. " +
      "Route any agent's citations through the CVO (POST /api/verify) to earn a verified grounding rate.",
    verified: [
      {
        agent: "Merit",
        verifier: "adversarial LLM judge + deterministic numeric verifier",
        benchmark: `${g.precisionRecall} on a published ${g.goldSet}-case gold set`,
        goldSet: g.goldSet,
        adversarialAttacks,
        attacksHeld,
        foolRate: adversarialAttacks ? b.fooled / adversarialAttacks : 0, // false citations paid / attacks (lower = harder to game)
        boundaryCasesLearned: bench.total, // NEW hard cases harvested from live traffic (grows from 0)
        status: "VERIFIED",
      },
    ],
    unranked: {
      note:
        "Agents whose citation is the writer LLM self-reporting which sources it used have no independent " +
        "grounding rate — there is nothing to verify. They become CHI-ranked only by routing through the CVO.",
    },
    verifyYourAgent: { mcpTool: "verify_citation", endpoint: "POST /api/verify", console: "/break.html" },
  });
}
