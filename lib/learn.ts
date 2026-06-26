/**
 * Self-improving Auditor (W1.3) — the verification layer learns from accumulated outcomes.
 *
 * Two evidence streams calibrate how much Merit trusts a source's SUPPORTED citations:
 *   1. settlement history (lib/history.ts) — a source's cited→released track record across runs, and
 *   2. appeal outcomes (.data/learn.json) — independent re-audits via /api/challenge, which are stronger
 *      evidence than one in-run verdict (a deliberate second look at the same source).
 *
 * The calibration only ever DISCOUNTS the Auditor's raw confidence for a PROVEN-unreliable source, and never
 * raises one and never flips the supported/refused DECISION — so graded settlement (#1) pays a flaky source
 * proportionally less over time while the proof-of-citation moat (and its measured 100% gold-set
 * precision/recall) stays exactly as tested. With no/insufficient evidence the multiplier is EXACTLY 1.0, so
 * default behavior — and the decision path the gold-set exercises — is unchanged (the regression gate).
 * Reflexion-style reflections summarize a source's record for display + agent context.
 */
import { historyStats, readHistory } from "./history";
import { loadDoc, saveDoc } from "./store";

export interface AppealTally {
  upheld: number;
  overturned: number;
}
type Store = Record<string, AppealTally>;

const APPEAL_WEIGHT = 2; // a deliberate re-audit weighs more than a single in-run settlement
const MIN_EVIDENCE = 3; // below this many observations, stay neutral (no calibration)
const FLOOR = 0.5; // a proven-unreliable source is discounted at most to half its raw confidence

let cache: Store | null = null;

// State lives in the durable document store (lib/store.ts): a sync local file + an optional Supabase mirror.
function load(): Store {
  if (cache) return cache;
  cache = loadDoc<Store>("learn", {});
  return cache;
}
function persist(store: Store): void {
  saveDoc("learn", store);
}

function histCounts(sourceId: string): { cited: number; released: number } {
  const recs = readHistory(sourceId);
  const cited = recs.filter((r) => r.cited);
  return { cited: cited.length, released: cited.filter((r) => r.released).length };
}

/** Record an independent appeal outcome for a source (supported = upheld). Best-effort; never throws. */
export function recordAppeal(sourceId: string, supported: boolean): void {
  try {
    const store = load();
    const t = store[sourceId] || (store[sourceId] = { upheld: 0, overturned: 0 });
    if (supported) t.upheld++;
    else t.overturned++;
    persist(store);
  } catch (e) {
    console.error("[learn] record failed:", (e as Error).message);
  }
}

export function appealTally(sourceId: string): AppealTally {
  return load()[sourceId] || { upheld: 0, overturned: 0 };
}

/** Beta-posterior reliability of a source in (0,1) — weighted appeals blended with settlement history.
 *  0.5 at no evidence; rises with upheld appeals + releases, falls with overturned appeals + refusals. */
export function reliability(sourceId: string): number {
  const t = appealTally(sourceId);
  const h = histCounts(sourceId);
  const pos = t.upheld * APPEAL_WEIGHT + h.released;
  const neg = t.overturned * APPEAL_WEIGHT + (h.cited - h.released);
  return (pos + 1) / (pos + neg + 2); // Beta(1,1) posterior mean
}

/** Total observations behind a source's reliability (weighted appeals + cited settlements). */
export function evidenceCount(sourceId: string): number {
  const t = appealTally(sourceId);
  return (t.upheld + t.overturned) * APPEAL_WEIGHT + histCounts(sourceId).cited;
}

/** The learned confidence multiplier for a source, in [FLOOR, 1.0]. EXACTLY 1.0 with insufficient evidence
 *  or a reliability ≥ 0.5 (a good/neutral source is never penalized); discounts toward FLOOR as a source
 *  proves unreliable. Conservative by design — it only ever LOWERS a flaky source's payout, never raises one,
 *  and never flips the supported/refused decision. */
export function confidenceMultiplier(sourceId: string): number {
  if (process.env.LEARN === "0") return 1.0; // master off-switch — restores the exact pre-learning behavior
  if (evidenceCount(sourceId) < MIN_EVIDENCE) return 1.0;
  const rel = reliability(sourceId);
  if (rel >= 0.5) return 1.0;
  return FLOOR + (1 - FLOOR) * (rel / 0.5);
}

/** Apply a source's learned reliability to the Auditor's raw confidence (for graded settlement #1). Returns
 *  raw UNCHANGED when there's no learned evidence — the regression gate that keeps default behavior, and the
 *  gold-set decision path, identical. */
export function calibratedConfidence(rawConfidence: number, sourceId: string): number {
  return Math.max(0, Math.min(1, rawConfidence * confidenceMultiplier(sourceId)));
}

/** A Reflexion-style one-line reflection on a source's track record — for display + agent context. */
export function reflection(sourceId: string): string {
  const t = appealTally(sourceId);
  const h = historyStats(sourceId);
  const appeals = t.upheld + t.overturned;
  const mult = confidenceMultiplier(sourceId);
  if (appeals === 0 && h.runs === 0) return `${sourceId}: no track record yet — neutral trust.`;
  const parts: string[] = [];
  if (h.runs > 0) parts.push(`${Math.round(h.releaseRate * 100)}% release over ${h.runs} run${h.runs === 1 ? "" : "s"}`);
  if (appeals > 0) parts.push(`${t.upheld}/${appeals} appeals upheld`);
  parts.push(`reliability ${reliability(sourceId).toFixed(2)}`);
  if (mult < 1) parts.push(`payout ×${mult.toFixed(2)} (proven unreliable)`);
  return `${sourceId}: ${parts.join("; ")}.`;
}

/** Global calibration snapshot — the learning curve a demo + a metrics page surface. */
export function globalCalibration(): {
  sources: number;
  appeals: number;
  upheld: number;
  overturned: number;
  upheldRate: number;
} {
  const store = load();
  let upheld = 0;
  let overturned = 0;
  for (const id of Object.keys(store)) {
    upheld += store[id].upheld;
    overturned += store[id].overturned;
  }
  const appeals = upheld + overturned;
  return { sources: Object.keys(store).length, appeals, upheld, overturned, upheldRate: appeals ? upheld / appeals : 0 };
}

/** Test seam: drop the in-memory cache so the next read reloads from disk. */
export function _resetLearnCache(): void {
  cache = null;
}
