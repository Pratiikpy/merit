import { describe, expect, it } from "vitest";
import { computeSplits, hasSplits } from "../lib/splits";

describe("weighted / recursive creator splits (Wave D #12)", () => {
  it("splits by weight and sums to the amount", () => {
    const shares = computeSplits([{ name: "A", weight: 2 }, { name: "B", weight: 1 }], 0.03);
    const a = shares.find((s) => s.name === "A")!;
    const b = shares.find((s) => s.name === "B")!;
    expect(a.amount).toBeCloseTo(0.02, 6);
    expect(b.amount).toBeCloseTo(0.01, 6);
    expect(a.weight).toBeCloseTo(2 / 3, 4);
    expect(shares.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(0.03, 6);
  });

  it("resolves a recipient recursively down the lineage", () => {
    const shares = computeSplits([{ name: "Team", weight: 1 }, { name: "C", weight: 1 }], 0.02, {
      resolve: (n) => (n === "Team" ? [{ name: "A", weight: 1 }, { name: "B", weight: 1 }] : null),
    });
    const byName = Object.fromEntries(shares.map((s) => [s.name, s.amount]));
    expect(byName["A"]).toBeCloseTo(0.005, 6); // half of Team's half
    expect(byName["B"]).toBeCloseTo(0.005, 6);
    expect(byName["C"]).toBeCloseTo(0.01, 6);
    expect(shares.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(0.02, 6);
  });

  it("guards against cycles (a self-referential recipient collapses to a leaf)", () => {
    const shares = computeSplits([{ name: "Loop", weight: 1 }], 0.01, {
      resolve: () => [{ name: "Loop", weight: 1 }], // always points back to itself
    });
    // must terminate and pay out exactly the amount
    expect(shares.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(0.01, 6);
  });

  it("drops zero/negative weights and merges duplicate leaves", () => {
    const shares = computeSplits([{ name: "A", weight: 1 }, { name: "A", weight: 1 }, { name: "Z", weight: 0 }], 0.02);
    expect(shares.length).toBe(1); // the two A's merge, Z dropped
    expect(shares[0].name).toBe("A");
    expect(shares[0].amount).toBeCloseTo(0.02, 6);
  });

  it("hasSplits detects a real split list", () => {
    expect(hasSplits([{ name: "A", weight: 1 }])).toBe(true);
    expect(hasSplits([])).toBe(false);
    expect(hasSplits(undefined)).toBe(false);
    expect(hasSplits([{ name: "", weight: 1 }])).toBe(false);
  });
});
