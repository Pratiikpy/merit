import { NextRequest, NextResponse } from "next/server";
import { getSpecialist } from "@/lib/specialists";
import { getCtx, patchCtx, type CiteResult } from "@/lib/runctx";
import { getSources } from "@/lib/registry";
import { discoverSources } from "@/lib/discover";
import { writeAnswer, citedNames, isCited, citationCount, verifyCitations } from "@/lib/llm";

export const runtime = "nodejs";

/**
 * A specialist agent's WORK endpoint — UNPAID. It delivers its contribution into
 * the shared run context; the lead agent then verifies the result and pays the
 * specialist separately (only for good work) via /api/agent/[id]/pay. This honors
 * Merit's "pay only for verified work" thesis at the agent-to-agent layer:
 * deliver first, get judged, then get paid (or refused).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const spec = getSpecialist(id);
  if (!spec) return NextResponse.json({ error: "unknown specialist" }, { status: 404 });
  const runId = req.nextUrl.searchParams.get("run") || "";
  const ctx = getCtx(runId);
  if (!ctx) return NextResponse.json({ error: "no run context" }, { status: 400 });

  try {
    // Idempotent: if this role's artifact already exists for the run, skip the
    // (LLM-costing) work — bounds cost to one pass per role per run even under replay.
    if (spec.role === "search" && ctx.sources.length > 0)
      return NextResponse.json({ ok: true, role: "search", count: ctx.sources.length, cached: true });
    if (spec.role === "write" && ctx.answer)
      return NextResponse.json({ ok: true, role: "write", cached: true });
    if (spec.role === "verify" && Object.keys(ctx.cite).length > 0)
      return NextResponse.json({ ok: true, role: "verify", cached: true });

    if (spec.role === "search") {
      let sources = ctx.discover ? await discoverSources(ctx.question, 6).catch(() => []) : [];
      if (!sources.length) sources = getSources().filter((s) => s.content && s.content.length > 0);
      patchCtx(runId, { sources });
      return NextResponse.json({ ok: true, role: "search", count: sources.length });
    }

    if (spec.role === "write") {
      // The pro writer (Scribe) is thorough; the budget writer (Quill) is terser → cites fewer.
      const answer = await writeAnswer(ctx.question, ctx.sources, spec.tier);
      patchCtx(runId, { answer });
      return NextResponse.json({ ok: true, role: "write", len: answer.length });
    }

    // verify — proof-of-citation. The PRO verify agent (Auditor) runs the adversarial
    // LLM judge on each claim; the BUDGET agent (Tally) does similarity-only — a real
    // capability difference between the two specialists, priced accordingly.
    const cited = citedNames(ctx.answer);
    const checkable = ctx.sources.filter((s) => isCited(cited, s.name) && s.verified);
    const support = await verifyCitations(
      ctx.answer,
      checkable.map((s) => ({ id: s.id, name: s.name, content: s.content, trap: s.trap })),
      spec.tier === "pro",
    );
    const cite: Record<string, CiteResult> = {};
    for (const s of ctx.sources) {
      const isC = isCited(cited, s.name);
      const sup = support[s.id];
      cite[s.id] = {
        cited: isC,
        supported: sup?.supported ?? false,
        confidence: sup?.confidence ?? 0,
        counterfactual: sup?.counterfactual ?? null,
        span: sup?.span ?? null,
        score: sup?.score ?? 0,
        reason: sup?.reason ?? "",
        count: isC ? Math.max(1, citationCount(ctx.answer, s.name)) : 0,
      };
    }
    patchCtx(runId, { cite });
    return NextResponse.json({ ok: true, role: "verify", checked: ctx.sources.length });
  } catch (e) {
    // Log details server-side; don't leak internal error strings to the caller.
    console.error(`[agent-work] ${id} failed:`, (e as Error).message);
    return NextResponse.json({ error: "work failed" }, { status: 500 });
  }
}
