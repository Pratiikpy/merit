/**
 * Pluggable verification adapters (#10) — the PRD's module E. Verification generalizes beyond the LLM judge
 * into a registry of named, mostly-deterministic checks a source can compose via `verify: AdapterId[]`. The
 * LLM judge + similarity stay the default for every source; declared adapters are EXTRA gates that only make
 * a source stricter (a failing adapter refuses), so they can never loosen the moat. All pure + unit-tested.
 */
import type { Source } from "./registry";
import { fabricatedFigures } from "./numcheck";

export interface AdapterResult {
  id: string;
  ok: boolean;
  reason: string;
}

type AdapterFn = (claim: string, content: string, source: Source) => AdapterResult;

const ADAPTERS: Record<string, AdapterFn> = {
  // Numeric: no $/% figure the source contradicts (the deterministic moat layer, reused as an adapter).
  numeric: (claim, content) => {
    const fab = fabricatedFigures(claim, content);
    return { id: "numeric", ok: fab.length === 0, reason: fab.length ? `cites the figure "${fab[0].raw}" the source contradicts` : "figures trace to the source" };
  },
  // Schema: the content parses as JSON (for structured API responses).
  schema: (_claim, content) => {
    try {
      JSON.parse(content);
      return { id: "schema", ok: true, reason: "content is valid JSON" };
    } catch {
      return { id: "schema", ok: false, reason: "content is not valid JSON (schema adapter)" };
    }
  },
  // Freshness: the content carries a recent (≥2025) year — a recency proxy for live data.
  freshness: (_claim, content) => {
    const m = content.match(/\b(20\d{2})\b/);
    const ok = !!m && Number(m[1]) >= 2025;
    return { id: "freshness", ok, reason: ok ? `fresh (${m![1]})` : "no recent (≥2025) timestamp (freshness adapter)" };
  },
  // Non-empty: the content is substantive enough to verify against at all.
  nonempty: (_claim, content) => {
    const ok = (content || "").trim().length >= 40;
    return { id: "nonempty", ok, reason: ok ? "substantive content" : "content too thin to verify (nonempty adapter)" };
  },
};

export function getAdapter(id: string): AdapterFn | undefined {
  return ADAPTERS[id];
}

/** Run each declared adapter; an unknown id is skipped (treated as ok). */
export function runAdapters(ids: string[], claim: string, content: string, source: Source): AdapterResult[] {
  return ids.map((id) => getAdapter(id)?.(claim, content, source) ?? { id, ok: true, reason: `unknown adapter "${id}" — skipped` });
}

/** Do all declared adapters pass? Returns the first failure for the refusal reason. No adapters = vacuously ok. */
export function adaptersPass(
  ids: string[] | undefined,
  claim: string,
  content: string,
  source: Source,
): { ok: boolean; failed?: AdapterResult } {
  if (!ids || ids.length === 0) return { ok: true };
  const failed = runAdapters(ids, claim, content, source).find((r) => !r.ok);
  return { ok: !failed, failed };
}
