/**
 * Autonomous budget allocation + constitutional abstention (W4) — turns the human budget arg into a DECISION
 * the lead makes, and adds a genuine when-to-refuse.
 *
 * allocateBudget: split a run's budget across candidate sources greedily by expected value PER DOLLAR
 * (expected release rate ÷ price), instead of paying in arbitrary order — so the lead spends where verified
 * value is most likely. shouldAbstain: if no source's expected release clears a bar, refuse the WHOLE run
 * with an explained reason rather than answering a question nothing can support. Pure + deterministic.
 */
import { round6 } from "./arc";

export interface SourceEV {
  id: string;
  price: number; // USDC per use
  expectedRelease: number; // 0..1 — e.g. learnedTrust / historical release rate
}

export interface Allocation {
  picks: Array<{ id: string; alloc: number; evPerDollar: number }>;
  spent: number;
  reserve: number;
}

/** Greedily allocate `budget` across sources by expected value per dollar, each capped at its price, never
 *  exceeding the budget. A free source (price 0) is always included. Returns the picks + the reserve left. */
export function allocateBudget(budget: number, sources: SourceEV[]): Allocation {
  const ranked = sources
    .map((s) => ({ id: s.id, price: Math.max(0, s.price), ev: Math.max(0, Math.min(1, s.expectedRelease)) }))
    .map((s) => ({ ...s, evPerDollar: s.price > 0 ? s.ev / s.price : Number.POSITIVE_INFINITY }))
    .sort((a, b) => b.evPerDollar - a.evPerDollar);
  const picks: Allocation["picks"] = [];
  let spent = 0;
  for (const s of ranked) {
    if (round6(spent + s.price) > budget + 1e-9) continue; // skip what doesn't fit; keep scanning cheaper ones
    spent = round6(spent + s.price);
    picks.push({ id: s.id, alloc: s.price, evPerDollar: s.evPerDollar });
  }
  return { picks, spent, reserve: round6(Math.max(0, budget - spent)) };
}

/** Constitutional abstention: refuse the whole run when the best source's expected release is below `bar` —
 *  the agent decides NOT to spend on a question nothing can credibly support. */
export function shouldAbstain(sources: SourceEV[], bar = 0.2): { abstain: boolean; reason: string; bestEV: number } {
  const bestEV = sources.reduce((m, s) => Math.max(m, Math.max(0, Math.min(1, s.expectedRelease))), 0);
  if (bestEV < bar) {
    return {
      abstain: true,
      bestEV,
      reason: `No source clears the ${bar.toFixed(2)} expected-support bar (best ${bestEV.toFixed(2)}) — abstaining rather than paying for an answer nothing supports.`,
    };
  }
  return { abstain: false, bestEV, reason: `Best source expected support ${bestEV.toFixed(2)} ≥ ${bar.toFixed(2)} — proceeding.` };
}
