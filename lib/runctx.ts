/**
 * In-process run context. The lead agent and the specialist endpoints share one
 * Node process (Next API routes), so heavy data (question, sources, answer) lives
 * here keyed by runId — only a tiny `?run=<id>` crosses the x402 wire. The payment
 * is real (buyer → specialist wallet); the work product flows through this store.
 */
import type { Source } from "./registry";

export interface CiteResult {
  cited: boolean; // the answer cites this source (exact tag match)
  supported: boolean; // the Auditor judged the source actually supports the claim
  confidence: number; // P(genuinely supported), 0..1 — grades settlement (#1) and seeds the market prior (#18)
  counterfactual?: string | null; // for a refusal: what would have flipped it to a pay (#2)
  span?: { text: string; start: number; end: number } | null; // #7: the source sentence the claim best matches
  score: number; // similarity evidence (cosine 0..1) behind the verdict
  reason: string; // the Auditor's one-line reason ("passage states $4.1T volume", etc.)
  count: number; // how many times cited
}

export interface RunCtx {
  question: string;
  budget: number;
  discover: boolean;
  sources: Source[]; // filled by the search specialist
  answer: string; // filled by the write specialist
  cite: Record<string, CiteResult>; // sourceId -> result, filled by the verify specialist
}

// Contexts expire 10 min after creation — defense-in-depth so a leaked runId can't
// replay a specialist work endpoint against a long-stale context (the run itself takes
// <1 min, and runAgent deletes its context in a finally block).
const TTL_MS = 10 * 60 * 1000;
const ctxs = new Map<string, { ctx: RunCtx; at: number }>();

export function createCtx(runId: string, init: Pick<RunCtx, "question" | "budget" | "discover">): RunCtx {
  const ctx: RunCtx = { ...init, sources: [], answer: "", cite: {} };
  ctxs.set(runId, { ctx, at: Date.now() });
  // Bound growth on a long-lived server: drop the oldest if we somehow accumulate.
  if (ctxs.size > 200) {
    const oldest = ctxs.keys().next().value;
    if (oldest) ctxs.delete(oldest);
  }
  return ctx;
}

export function getCtx(runId: string): RunCtx | undefined {
  const e = ctxs.get(runId);
  if (!e) return undefined;
  if (Date.now() - e.at > TTL_MS) {
    ctxs.delete(runId); // expired — treat as gone
    return undefined;
  }
  return e.ctx;
}

export function patchCtx(runId: string, patch: Partial<RunCtx>): void {
  const e = ctxs.get(runId);
  if (e) Object.assign(e.ctx, patch);
}

export function deleteCtx(runId: string): void {
  ctxs.delete(runId);
}
