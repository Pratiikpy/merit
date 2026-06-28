/**
 * Self-bootstrapping benchmark — the gold set grows from production.
 *
 * Merit's verifier is benchmarked at 100% precision/recall on a FIXED gold set. The hardest, most valuable
 * cases to add are the ones the live verifier is least sure about — citations whose support confidence lands
 * near the decision boundary. Every run logs those uncertain cases as benchmark CANDIDATES; over time the
 * benchmark co-evolves with real traffic (active learning on an adversarial oracle) instead of staying static.
 * A human/meta-adjudicator can later promote a candidate into the gold set. Pure data — never gates a payment.
 */
import { loadDoc, saveDoc } from "./store";

export interface BenchCandidate {
  source: string;
  claim: string;
  verdict: "released" | "refused";
  confidence: number; // the Auditor's support confidence (uncertainty is what makes it gold-set-worthy)
  runId: string;
  at: number;
}

const LOW = 0.25, HIGH = 0.78, CAP = 500;
const key = (c: { source: string; claim: string }) => `${c.source}::${c.claim.slice(0, 80)}`;

/** Append the uncertain (boundary-confidence) citation cases from a run, deduped, capped. */
export function recordBenchCandidates(cands: BenchCandidate[]): number {
  const fresh = cands.filter((c) => c.confidence >= LOW && c.confidence <= HIGH && c.claim);
  if (!fresh.length) return 0;
  const all = loadDoc<BenchCandidate[]>("benchmark", []);
  const seen = new Set(all.map(key));
  const add = fresh.filter((c) => !seen.has(key(c)));
  if (!add.length) return 0;
  saveDoc("benchmark", [...all, ...add].slice(-CAP));
  return add.length;
}

export function readBench(): BenchCandidate[] {
  return loadDoc<BenchCandidate[]>("benchmark", []);
}

/** Summary for the API: how the benchmark is growing + the split. */
export function benchStats(): { total: number; released: number; refused: number; avgConfidence: number } {
  const all = readBench();
  const released = all.filter((c) => c.verdict === "released").length;
  const avg = all.length ? all.reduce((s, c) => s + c.confidence, 0) / all.length : 0;
  return { total: all.length, released, refused: all.length - released, avgConfidence: Math.round(avg * 1000) / 1000 };
}
