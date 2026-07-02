/**
 * Pluggable NLI / factual-consistency scorer for the verification engine (M1).
 *
 * State-of-the-art citation verification decomposes a claim and checks entailment against the source with a
 * small, cheap, benchmarkable model — e.g. Vectara's HHEM-2.1-Open (T5) or MiniCheck-7B — which match or beat
 * far larger LLMs on claim-wise faithfulness at a fraction of the cost. We keep the model OUT of this repo and
 * behind an HTTP boundary so the engine stays dependency-light and offline-safe:
 *
 *   - Unconfigured (default): `scoreNLI` returns `null` → the engine falls back to the LLM judge (today's behavior).
 *   - Configured via `MERIT_NLI_URL`: POST {claim, source} → expect {score: 0..1} (probability the source
 *     SUPPORTS the claim). Point this at a local HHEM/MiniCheck server or a hosted factual-consistency API.
 *
 * This lets M1 ship + be benchmarked without bundling a model, and lets deployments plug in a real scorer later
 * with zero code change. Returning `null` on any failure is deliberate: the NLI layer is additive evidence, it
 * must never hard-fail a verification (the numeric verifier + LLM judge remain the backstops).
 */

export function nliAvailable(): boolean {
  return !!process.env.MERIT_NLI_URL;
}

/** 0..1 support probability from the configured scorer, or null if unavailable / errored. */
export async function scoreNLI(claim: string, source: string): Promise<number | null> {
  const url = process.env.MERIT_NLI_URL;
  if (!url) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Number(process.env.MERIT_NLI_TIMEOUT_MS || 8000));
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim, source }),
      signal: controller.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) return null;
    const d = (await r.json()) as { score?: unknown };
    const s = Number(d?.score);
    return Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : null;
  } catch {
    return null; // additive layer — never throw
  }
}

/** Model tag recorded on every verdict for reproducibility / benchmark versioning. */
export function nliModelTag(): string {
  return process.env.MERIT_NLI_MODEL || (nliAvailable() ? "custom-nli" : "none");
}
