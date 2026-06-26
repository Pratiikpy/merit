import { describe, it, expect } from "vitest";
import { extractFigures, fabricatedFigures } from "../lib/numcheck";

const money = (s: string) => extractFigures(s).find((f) => f.kind === "money")?.value ?? NaN;
const pct = (s: string) => extractFigures(s).find((f) => f.kind === "percent")?.value ?? NaN;

describe("extractFigures (normalizes $-money and %-percent figures)", () => {
  // toBeCloseTo because magnitude multiplication is floating point (4.1 * 1e12 !== the 4.1e12 literal) —
  // immaterial to the logic, where the support tolerance is 50%.
  it("parses magnitude letters, words, commas, and tiny decimals", () => {
    expect(money("$4.1T")).toBeCloseTo(4.1e12, -6);
    expect(money("$90 million")).toBeCloseTo(90e6, -3);
    expect(money("$0.000001")).toBeCloseTo(1e-6, 9);
    expect(money("$4,100,000,000,000")).toBeCloseTo(4.1e12, -6);
  });
  it("parses bare magnitude words and percentages", () => {
    expect(money("reached 4.1 trillion in volume")).toBeCloseTo(4.1e12, -6);
    expect(pct("up 43% this year")).toBe(43);
  });
  it("does not double-count a $-prefixed magnitude word", () => {
    expect(extractFigures("$4.1 trillion").filter((f) => f.kind === "money")).toHaveLength(1);
  });
  it("returns nothing for prose with no $/% figures (years, bare counts ignored)", () => {
    expect(extractFigures("in 2026 some 12 vendors shipped regulatory clarity")).toHaveLength(0);
  });
});

describe("fabricatedFigures (deterministic numeric proof-of-citation)", () => {
  it("flags an order-of-magnitude fabrication the source contradicts", () => {
    const fab = fabricatedFigures("settlement hit $40T in annualized volume", "annualized volume reached $4.1T last year");
    expect(fab).toHaveLength(1);
    expect(fab[0].value).toBe(40e12);
  });
  it("allows a paraphrase / rounding within tolerance (no false-refusal)", () => {
    expect(fabricatedFigures("about $4 trillion in volume", "volume reached $4.1 trillion")).toHaveLength(0);
  });
  it("flags a fabricated percentage", () => {
    expect(fabricatedFigures("adoption surged 400%", "adoption grew 43% last quarter")).toHaveLength(1);
  });
  it("matches a percentage that agrees", () => {
    expect(fabricatedFigures("adoption grew 43%", "a 43% rise in adoption")).toHaveLength(0);
  });
  it("is conservative: does NOT flag when the source has no comparable figure (left to the LLM judge)", () => {
    expect(fabricatedFigures("the market is worth $40T", "stablecoins improve cross-border settlement")).toHaveLength(0);
  });
  it("matches against ANY same-kind source figure (multi-figure source)", () => {
    expect(fabricatedFigures("fees fell to $90M", "volume $4.1T; fees around $90M")).toHaveLength(0);
  });
  it("never flags a claim that asserts no figures", () => {
    expect(fabricatedFigures("regulatory clarity helped adoption", "anything at all $5T 50%")).toHaveLength(0);
  });
  it("does not cross kinds: a % claim is not judged against $ source figures", () => {
    expect(fabricatedFigures("rose 40%", "the market is $4.1T")).toHaveLength(0);
  });
});
