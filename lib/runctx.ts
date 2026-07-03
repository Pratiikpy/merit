/**
 * Run context shared between the lead agent and the specialist endpoints, keyed by runId — only a tiny
 * `?run=<id>` crosses the x402 wire; the heavy work product (question, sources, answer, cite) flows through here.
 *
 * On a single-process server (`next start`) the in-process Map below is the whole story. On Vercel serverless
 * the lead and each specialist self-fetch land on DIFFERENT instances, each with its own empty Map — so the
 * context is ALSO mirrored to the shared store (Supabase). The lead persists the context (awaited) before each
 * specialist self-fetch; the specialist hydrates it, does its work, persists its output; the lead hydrates the
 * result back. Postgres is strongly consistent, so the persist→hydrate round-trip is reliable. When the mirror
 * is disabled (local/tests) hydrate/persist are no-ops and the shared in-process Map serves the whole run.
 */
import type { Source } from "./registry";
import { deleteDoc, loadDocFromMirror, saveDocNow } from "./store";

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

const docName = (runId: string) => `runctx_${runId}`;

/** Mirror the current context (awaited) so a specialist endpoint on ANOTHER serverless instance can read it.
 *  No-op when the mirror is disabled (a single process already shares the Map). */
export async function persistCtx(runId: string): Promise<void> {
  const e = ctxs.get(runId);
  if (e) await saveDocNow(docName(runId), e);
}

/** patchCtx + persist, so the next specialist self-fetch sees the update across instances. */
export async function persistPatch(runId: string, patch: Partial<RunCtx>): Promise<void> {
  patchCtx(runId, patch);
  await persistCtx(runId);
}

/** Load the context from the shared mirror into the local Map — an authoritative read that is read-your-writes
 *  with persistCtx (Postgres strong consistency). A specialist endpoint calls this before reading the context;
 *  the lead calls it to pick up a specialist's write-back that landed on another instance. No-op when the
 *  mirror is disabled (single process) or the doc is absent/expired — the local Map then stands. */
export async function rehydrateCtx(runId: string): Promise<void> {
  const v = await loadDocFromMirror<{ ctx: RunCtx; at: number }>(docName(runId));
  if (v && v.ctx && typeof v.at === "number" && Date.now() - v.at <= TTL_MS) ctxs.set(runId, v);
}

export function deleteCtx(runId: string): void {
  ctxs.delete(runId);
  void deleteDoc(docName(runId)); // reap the mirror row (best-effort; the run is over)
}
