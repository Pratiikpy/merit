/**
 * Peer-prediction settlement (W4) — Bayesian Truth Serum (Prelec 2004) + the Surprisingly Popular algorithm
 * (Prelec 2017). Resolves a CONTESTED citation (does it survive appeal?) from a panel of validator reports
 * with NO ground truth and NO single trusted Auditor — exactly the regime Merit's "per-inference attribution
 * is nearly impossible to prove" thesis lives in. Each validator reports an answer (0/1) AND a prediction of
 * how the rest of the panel will answer; truthful reporting is the Bayesian-Nash equilibrium. Pure +
 * deterministic so the mechanism is unit-tested; feeds the citation prediction market (#18) + bounty (#8).
 */
const EPS = 1e-6;
const clampP = (p: number) => Math.max(EPS, Math.min(1 - EPS, p));

export interface BtsReport {
  answer: 0 | 1; // the validator's own verdict (1 = the citation survives appeal)
  prediction: number; // its stated P(a randomly-drawn OTHER validator answers 1)
}

/** The Surprisingly Popular verdict: the answer whose ACTUAL frequency exceeds its average PREDICTED
 *  frequency — provably correct under a Bayesian model, with no ground truth. `surprise` is how much the
 *  winning answer beat its prediction (a confidence proxy). */
export function surprisinglyPopular(reports: BtsReport[]): {
  answer: 0 | 1;
  surprise: number;
  actual1: number;
  predicted1: number;
} {
  const n = reports.length;
  if (n === 0) return { answer: 0, surprise: 0, actual1: 0, predicted1: 0 };
  const actual1 = reports.reduce((a, r) => a + r.answer, 0) / n;
  const predicted1 = reports.reduce((a, r) => a + clampP(r.prediction), 0) / n;
  const answer: 0 | 1 = actual1 - predicted1 > 0 ? 1 : 0;
  const surprise = answer === 1 ? actual1 - predicted1 : 1 - actual1 - (1 - predicted1);
  return { answer, surprise: Math.abs(surprise), actual1, predicted1 };
}

/** Bayesian Truth Serum per-validator scores: an information score (truth is rewarded because it is more
 *  common than collectively predicted) minus a prediction penalty (KL divergence of the stated prediction
 *  from the empirical frequency). Truthful reporting maximizes expected score — incentive-compatible with no
 *  ground truth. Guarded against log(0) so extreme inputs never produce NaN/Infinity. */
export function btsScores(reports: BtsReport[], alpha = 1): number[] {
  const n = reports.length;
  if (n === 0) return [];
  const x1 = clampP(reports.reduce((a, r) => a + r.answer, 0) / n);
  const x0 = clampP(1 - x1);
  const gY1 = Math.exp(reports.reduce((a, r) => a + Math.log(clampP(r.prediction)), 0) / n);
  const gY0 = Math.exp(reports.reduce((a, r) => a + Math.log(clampP(1 - r.prediction)), 0) / n);
  return reports.map((r) => {
    const info = r.answer === 1 ? Math.log(x1 / gY1) : Math.log(x0 / gY0);
    const y = clampP(r.prediction);
    const predPenalty = x1 * Math.log(x1 / y) + x0 * Math.log(x0 / (1 - y)); // KL(empirical ‖ prediction)
    return info - alpha * predPenalty;
  });
}
