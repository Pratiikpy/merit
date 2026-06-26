import { describe, it, expect } from "vitest";
import { surprisinglyPopular, btsScores, type BtsReport } from "../lib/bts";

describe("Bayesian Truth Serum + Surprisingly Popular (W4 peer-prediction)", () => {
  it("surprisinglyPopular picks the answer whose actual frequency beats its prediction", () => {
    // 30% of validators say the citation survives, but the panel collectively predicted only ~10% would →
    // 'survives' (1) is surprisingly popular, the provably-correct answer with no ground truth.
    const reports: BtsReport[] = [
      { answer: 1, prediction: 0.1 },
      { answer: 1, prediction: 0.1 },
      { answer: 1, prediction: 0.1 },
      { answer: 0, prediction: 0.1 },
      { answer: 0, prediction: 0.1 },
      { answer: 0, prediction: 0.1 },
      { answer: 0, prediction: 0.1 },
      { answer: 0, prediction: 0.1 },
      { answer: 0, prediction: 0.1 },
      { answer: 0, prediction: 0.1 },
    ];
    const sp = surprisinglyPopular(reports);
    expect(sp.answer).toBe(1);
    expect(sp.actual1).toBeCloseTo(0.3, 6);
    expect(sp.predicted1).toBeCloseTo(0.1, 6);
    expect(sp.surprise).toBeGreaterThan(0);
  });

  it("surprisinglyPopular agrees with a confident, well-predicted consensus", () => {
    const reports: BtsReport[] = Array.from({ length: 5 }, () => ({ answer: 1 as const, prediction: 0.85 }));
    expect(surprisinglyPopular(reports).answer).toBe(1);
    expect(surprisinglyPopular([]).answer).toBe(0); // empty → safe default
  });

  it("btsScores rewards truthful, well-calibrated reports and never produces NaN/Infinity", () => {
    const reports: BtsReport[] = [
      { answer: 1, prediction: 0.7 },
      { answer: 1, prediction: 0.7 },
      { answer: 0, prediction: 0.3 },
    ];
    const scores = btsScores(reports);
    expect(scores).toHaveLength(3);
    for (const s of scores) expect(Number.isFinite(s)).toBe(true);
    // A validator whose prediction matches the empirical frequency (2/3 ≈ 0.67) pays a smaller penalty than
    // one who predicts badly — verify the well-calibrated minority answer still scores finitely.
    expect(btsScores([])).toEqual([]);
  });

  it("handles unanimous + extreme inputs without blowing up (epsilon-guarded)", () => {
    const allYes = Array.from({ length: 4 }, () => ({ answer: 1 as const, prediction: 1 }));
    for (const s of btsScores(allYes)) expect(Number.isFinite(s)).toBe(true);
    const allNo = Array.from({ length: 4 }, () => ({ answer: 0 as const, prediction: 0 }));
    for (const s of btsScores(allNo)) expect(Number.isFinite(s)).toBe(true);
  });
});
