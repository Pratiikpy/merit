import { describe, it, expect } from "vitest";
import { allocateBudget, shouldAbstain, type SourceEV } from "../lib/planner";

describe("autonomous budget allocation + abstention (W4)", () => {
  const S: SourceEV[] = [
    { id: "cheap-good", price: 0.01, expectedRelease: 0.9 }, // ev/$ = 90
    { id: "pricey-good", price: 0.1, expectedRelease: 0.9 }, // ev/$ = 9
    { id: "cheap-weak", price: 0.01, expectedRelease: 0.1 }, // ev/$ = 10
  ];

  it("allocates by expected value per dollar and respects the budget", () => {
    const a = allocateBudget(0.05, S);
    const ids = a.picks.map((p) => p.id);
    expect(ids[0]).toBe("cheap-good"); // best ev/$ first
    expect(a.spent).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(a.reserve).toBeCloseTo(0.05 - a.spent, 6);
    // pricey-good ($0.10) cannot fit a $0.05 budget; the two cheap ones do
    expect(ids).toContain("cheap-weak");
    expect(ids).not.toContain("pricey-good");
  });

  it("includes a free source for free and never overspends", () => {
    const a = allocateBudget(0.0, [{ id: "free", price: 0, expectedRelease: 0.5 }, { id: "paid", price: 0.01, expectedRelease: 0.9 }]);
    expect(a.picks.map((p) => p.id)).toEqual(["free"]);
    expect(a.spent).toBe(0);
  });

  it("abstains when no source clears the expected-support bar", () => {
    const weak: SourceEV[] = [{ id: "a", price: 0.01, expectedRelease: 0.1 }, { id: "b", price: 0.01, expectedRelease: 0.15 }];
    const d = shouldAbstain(weak, 0.2);
    expect(d.abstain).toBe(true);
    expect(d.bestEV).toBeCloseTo(0.15, 6);
    expect(d.reason).toMatch(/abstain/i);
  });

  it("proceeds when a source clears the bar", () => {
    const d = shouldAbstain(S, 0.2);
    expect(d.abstain).toBe(false);
    expect(d.bestEV).toBeCloseTo(0.9, 6);
  });
});
