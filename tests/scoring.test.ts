import { describe, it, expect } from "vitest";
import { decideVerdict, releaseMerit, refundMerit, repScore, reasonFor, counterfactualFor, gradeSpecialist, withinBudget, crewMerit, summarizeRelease, gradedNano } from "../lib/scoring";

describe("decideVerdict (the agency decision table)", () => {
  it("releases only when cited + verified + supported", () => {
    expect(decideVerdict(true, true, true)).toEqual({ release: true });
  });
  it("refuses uncited first, regardless of the rest", () => {
    expect(decideVerdict(false, true, true)).toEqual({ release: false, reasonKind: "uncited" });
    expect(decideVerdict(false, false, false)).toEqual({ release: false, reasonKind: "uncited" });
  });
  it("refuses a cited-but-unverified source on identity", () => {
    expect(decideVerdict(true, false, true)).toEqual({ release: false, reasonKind: "identity" });
  });
  it("refuses a cited+verified-but-unsupported source", () => {
    expect(decideVerdict(true, true, false)).toEqual({ release: false, reasonKind: "unsupported" });
  });
});

describe("merit + reputation scores", () => {
  it("release merit caps at +3", () => {
    expect(releaseMerit(1)).toBe(1);
    expect(releaseMerit(5)).toBe(3);
  });
  it("refund merit is negative, identity-spoof worst", () => {
    expect(refundMerit("identity")).toBe(-6);
    expect(refundMerit("uncited")).toBe(-4);
    expect(refundMerit("unsupported")).toBe(-3);
  });
  it("on-chain feedback score: paid positive, refused negative", () => {
    expect(repScore(true)).toBe(100);
    expect(repScore(false, "identity")).toBe(-100);
    expect(repScore(false, "uncited")).toBe(-20);
    expect(repScore(false, "unsupported")).toBe(-40);
  });
});

describe("reasonFor", () => {
  it("gives a distinct human-readable reason per refusal kind", () => {
    expect(reasonFor("uncited")).toContain("Not cited");
    expect(reasonFor("identity")).toContain("identity");
    expect(reasonFor("unsupported")).toContain("not supported");
  });
});

describe("counterfactualFor (refusal feedback — what would flip it, #2)", () => {
  it("gives actionable hints for uncited + identity; defers to the cite counterfactual for unsupported", () => {
    expect(counterfactualFor("uncited")).toContain("Not cited");
    expect(counterfactualFor("identity")).toContain("register");
    expect(counterfactualFor("unsupported", "Drop the figure $40T")).toContain("$40T");
    expect(counterfactualFor("unsupported", null)).toContain("isn't supported");
  });
});

describe("gradeSpecialist (pay only for delivered, verified work)", () => {
  const full = { poolSize: 6, releaseCount: 4, allSourcesChecked: true };
  it("never pays a specialist that didn't deliver (inline fallback was used)", () => {
    expect(gradeSpecialist("search", false, full)).toBe(false);
    expect(gradeSpecialist("write", false, full)).toBe(false);
    expect(gradeSpecialist("verify", false, full)).toBe(false);
  });
  it("search earns iff it found a usable pool (≥2)", () => {
    expect(gradeSpecialist("search", true, { ...full, poolSize: 2 })).toBe(true);
    expect(gradeSpecialist("search", true, { ...full, poolSize: 1 })).toBe(false);
  });
  it("write earns iff ≥1 citation was paid (verified value produced)", () => {
    expect(gradeSpecialist("write", true, { ...full, releaseCount: 1 })).toBe(true);
    expect(gradeSpecialist("write", true, { ...full, releaseCount: 0 })).toBe(false);
  });
  it("verify earns iff it checked every source of a non-empty pool", () => {
    expect(gradeSpecialist("verify", true, { ...full, allSourcesChecked: true })).toBe(true);
    expect(gradeSpecialist("verify", true, { ...full, allSourcesChecked: false })).toBe(false);
    expect(gradeSpecialist("verify", true, { poolSize: 0, releaseCount: 0, allSourcesChecked: true })).toBe(false);
  });
});

describe("crewMerit (quality-weighted writer reputation)", () => {
  it("scales the writer's earned merit with released citations, clamped 1..4", () => {
    expect(crewMerit("write", 4)).toBe(4); // thorough writer earns more
    expect(crewMerit("write", 3)).toBe(3); // terser writer earns less
    expect(crewMerit("write", 0)).toBe(1); // a paid writer still earns ≥1
    expect(crewMerit("write", 9)).toBe(4); // capped
  });
  it("is flat for search + verify (binary delivery)", () => {
    expect(crewMerit("search", 4)).toBe(2);
    expect(crewMerit("verify", 1)).toBe(2);
  });
});

describe("withinBudget (labor + creators stay inside the whole-run cap)", () => {
  it("allows a hire that fits, rejects one that overruns (6-dp safe)", () => {
    expect(withinBudget(0.02, 0.008, 0.5)).toBe(true);
    expect(withinBudget(0.495, 0.008, 0.5)).toBe(false);
    expect(withinBudget(0, 0.5, 0.5)).toBe(true); // exact fit
    expect(withinBudget(0.5, 0.001, 0.5)).toBe(false);
  });
  it("respects a zero budget — nothing is affordable", () => {
    expect(withinBudget(0, 0.003, 0)).toBe(false);
  });
  it("allows an accumulated sum that lands exactly on budget (float-safe via round6 + the 1e-9 epsilon)", () => {
    // Accumulating sub-cent creator prices float-drifts (0.018 + 0.009 ≈ 0.027000000000000003);
    // round6 + epsilon must keep an exact-fit hire payable, never falsely budget-block a creator.
    expect(withinBudget(0.018, 0.009, 0.027)).toBe(true);
    expect(withinBudget(0.009 + 0.009, 0.009, 0.027)).toBe(true);
  });
  it("rejects a hire genuinely over budget, beyond epsilon", () => {
    expect(withinBudget(0.027, 0.002, 0.028)).toBe(false); // 0.029 > 0.028 — real overspend blocked
  });
});

describe("summarizeRelease (run-receipt reflects ACTUAL settlement, not intent)", () => {
  it("reports released when at least one nanopayment settled", () => {
    expect(summarizeRelease(true, 3)).toEqual({ released: true, settlementFailed: false });
    expect(summarizeRelease(true, 1)).toEqual({ released: true, settlementFailed: false }); // partial still counts
  });
  it("reports an intended release whose settlement ALL failed as NOT released (the receipt-integrity bug)", () => {
    // verdict said pay, but zero USDC moved → the live stream emitted a refund, so the
    // summary must too. Never a phantom released:true, amount:0.
    expect(summarizeRelease(true, 0)).toEqual({ released: false, settlementFailed: true });
  });
  it("a normal refusal (never intended to pay) is not a settlement failure", () => {
    expect(summarizeRelease(false, 0)).toEqual({ released: false, settlementFailed: false });
  });
  it("reports actual money movement even for a verdict that refused (the receipt never hides a real payment)", () => {
    // `released` reflects what the CHAIN did: if USDC moved, it's released. A refused source
    // never reaches settlement, so this is unreachable in practice — but pinning it guarantees the
    // receipt can never silently launder a payment to a source the verdict didn't authorize.
    expect(summarizeRelease(false, 2)).toEqual({ released: true, settlementFailed: false });
  });
});

describe("gradedNano (confidence-graded settlement, #1)", () => {
  it("at full confidence equals the prior clamp(1,5,count)", () => {
    expect(gradedNano(1, 1)).toBe(1);
    expect(gradedNano(3, 1)).toBe(3);
    expect(gradedNano(9, 1)).toBe(5); // clamped at 5
  });
  it("pays fewer nanopayments at lower confidence (the grade)", () => {
    expect(gradedNano(4, 0.5)).toBe(2); // round(2.0)
    expect(gradedNano(2, 0.6)).toBe(1); // round(1.2)
    expect(gradedNano(4, 0.9)).toBe(4); // round(3.6)
  });
  it("a supported citation always settles at least one nanopayment (the floor)", () => {
    expect(gradedNano(1, 0.45)).toBe(1);
    expect(gradedNano(1, 0)).toBe(1);
    expect(gradedNano(0, 0.9)).toBe(1); // count floored to 1
  });
});
