import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { Ballot, Vote } from "../lib/jury";

let mod: typeof import("../lib/jury");

beforeEach(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-jury-"));
  delete process.env.MERIT_STORE;
  delete process.env.MERIT_NLI_URL; // NLI off → every non-numeric claim escalates to the panel (deterministic)
  delete process.env.MERIT_JURY_WEIGHTED;
  delete process.env.MERIT_JURY_THRESHOLD;
  delete process.env.MERIT_JURY_MODELS;
  process.env.STUB = "1";
  mod = await import("../lib/jury");
  mod._resetJury();
});

// A ballot factory + a deterministic cast that votes by the model name (so a panel can be scripted).
function ballot(model: string, vote: Vote, confidence = vote === "SUPPORTED" ? 0.7 : 0.15): Ballot {
  return { model, vote, confidence, reason: `${vote} test`, attestation: null, latencyMs: 1 };
}

describe("decomposeClaims", () => {
  it("splits multi-sentence answers into atomic claims and preserves decimals", () => {
    const claims = mod.decomposeClaims(
      "Cross-border B2B settlement crossed $4.1T in annualized volume [[StableData]]. Regulatory clarity unlocked enterprise volume [[Ortiz]]. Embedded wallets drove consumer usage [[ChainLetter]].",
    );
    expect(claims).toHaveLength(3);
    expect(claims[0]).toContain("$4.1T");
    expect(claims.join(" ")).not.toContain("[["); // citation markers stripped
  });

  it("skips trivially short fragments", () => {
    const claims = mod.decomposeClaims("Yes. Cross-border settlement crossed four trillion dollars this year.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain("Cross-border");
  });

  it("dedupes repeated sentences", () => {
    const claims = mod.decomposeClaims("Adoption grew sharply this year. Adoption grew sharply this year.");
    expect(claims).toHaveLength(1);
  });

  it("caps the number of claims", () => {
    process.env.MERIT_JURY_MAX_CLAIMS = "3";
    const many = Array.from({ length: 10 }, (_, i) => `Claim number ${i} about stablecoin adoption trends.`).join(" ");
    // re-import so the module-level cap picks up the env
    delete process.env.MERIT_JURY_MAX_CLAIMS;
    expect(mod.decomposeClaims(many).length).toBeLessThanOrEqual(8); // default cap
  });

  it("a single short claim with no sentence terminator still yields one claim", () => {
    expect(mod.decomposeClaims("stablecoin settlement volume reached record highs")).toHaveLength(1);
  });
});

describe("tallyConsensus", () => {
  it("clears on a supermajority of clear SUPPORTED votes", () => {
    const t = mod.tallyConsensus([ballot("a", "SUPPORTED"), ballot("b", "SUPPORTED"), ballot("c", "REFUTED")], { threshold: 0.66 });
    expect(t.supportRatio).toBeCloseTo(2 / 3, 3);
    expect(t.verdict).toBe("SUPPORTED");
  });

  it("refuses below threshold", () => {
    const t = mod.tallyConsensus([ballot("a", "SUPPORTED"), ballot("b", "REFUTED"), ballot("c", "REFUTED")], { threshold: 0.66 });
    expect(t.verdict).toBe("REFUSED");
  });

  it("counts UNCLEAR against (the safe direction)", () => {
    const t = mod.tallyConsensus([ballot("a", "SUPPORTED"), ballot("b", "SUPPORTED"), ballot("c", "UNCLEAR")], { threshold: 0.75 });
    expect(t.tally.unclear).toBe(1);
    expect(t.supportRatio).toBeCloseTo(2 / 3, 3);
    expect(t.verdict).toBe("REFUSED"); // 0.667 < 0.75
  });

  it("excludes ABSTAIN from the ratio but enforces quorum", () => {
    // 2 abstain, 1 support → participating=1 < default quorum(2 for roster≥2) → REFUSED despite 100% support
    const t = mod.tallyConsensus([ballot("a", "SUPPORTED"), ballot("b", "ABSTAIN"), ballot("c", "ABSTAIN")]);
    expect(t.participating).toBe(1);
    expect(t.supportRatio).toBe(1);
    expect(t.quorumMet).toBe(false);
    expect(t.verdict).toBe("REFUSED");
  });

  it("reputation weights change the outcome", () => {
    const ballots = [ballot("trusted", "SUPPORTED"), ballot("x", "REFUTED"), ballot("y", "REFUTED")];
    const equal = mod.tallyConsensus(ballots, { threshold: 0.6 });
    expect(equal.verdict).toBe("REFUSED");
    const weighted = mod.tallyConsensus(ballots, { threshold: 0.6, weights: { trusted: 10, x: 1, y: 1 } });
    expect(weighted.supportRatio).toBeGreaterThan(0.6);
    expect(weighted.verdict).toBe("SUPPORTED");
  });
});

describe("runJury pipeline (injected cast)", () => {
  const SOURCE = "Cross-border B2B stablecoin settlement crossed $4.1T in annualized volume in 2026. Regulatory clarity from MiCA unlocked enterprise volume. Embedded wallets drove the first real consumer usage.";

  // Panel votes SUPPORTED unless the claim mentions "quantum" (an off-topic fabrication) → all REFUTED.
  const cast = async (model: string, claim: string): Promise<Ballot> =>
    ballot(model, /quantum/i.test(claim) ? "REFUTED" : "SUPPORTED");

  it("grades settlement per claim — pays only the claims that pass", async () => {
    const answer = "Cross-border settlement crossed four trillion in annualized volume. Quantum teleportation now settles payments instantly and for free.";
    const r = await mod.runJury({ answer, source: SOURCE, amount: 0.02 }, cast);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.certificate;
    expect(c.tally.totalClaims).toBe(2);
    expect(c.tally.supported).toBe(1);
    expect(c.tally.refused).toBe(1);
    expect(c.tally.gradedUsdc).toBeCloseTo(0.01, 6); // one of two claims, half the amount
    expect(c.tally.allOrNothingUsdc).toBe(0); // a weakest-link rail would have refunded the honest claim to zero
    expect(c.tally.savedByGrading).toBeCloseTo(0.01, 6);
  });

  it("all claims pass → graded equals the full amount (== weakest-link here)", async () => {
    const answer = "Cross-border settlement crossed four trillion in annualized volume. Regulatory clarity unlocked enterprise volume.";
    const r = await mod.runJury({ answer, source: SOURCE, amount: 0.02 }, cast);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.certificate.tally.supported).toBe(2);
    expect(r.certificate.tally.gradedUsdc).toBeCloseTo(0.02, 6);
    expect(r.certificate.tally.allOrNothingUsdc).toBeCloseTo(0.02, 6);
    expect(r.certificate.tally.savedByGrading).toBe(0); // all pass → graded == weakest-link, nothing "saved"
  });

  it("the deterministic numeric floor refuses a fabricated figure WITHOUT convening the panel", async () => {
    let convened = false;
    const spy = async (m: string, claim: string): Promise<Ballot> => { convened = true; return ballot(m, "SUPPORTED"); };
    const answer = "Cross-border settlement hit $40T in annualized volume this year.";
    const r = await mod.runJury({ answer, source: SOURCE, amount: 0.01 }, spy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.certificate.claims[0].verdict).toBe("REFUSED");
    expect(r.certificate.claims[0].escalated).toBe(false);
    expect(r.certificate.claims[0].ballots).toHaveLength(0);
    expect(convened).toBe(false); // the free numeric floor decided — no paid panel call
  });

  it("emits a signed, Merkle-committed, id'd certificate", async () => {
    process.env.MERIT_SIGNING_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const r = await mod.runJury({ answer: "Regulatory clarity unlocked enterprise stablecoin volume this year.", source: SOURCE, amount: 0.01 }, cast);
    delete process.env.MERIT_SIGNING_KEY;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.certificate;
    expect(c.schema).toBe("merit.cvo/v3");
    expect(c.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(c.ballotCount).toBe(c.jurors.length); // one claim × the roster
    expect(c.signer).toBeTruthy();
    expect(c.signature).toBeTruthy();
    expect(c.certificateId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("records the certificate into the mirrored log + stats", async () => {
    await mod.runJury({ answer: "Regulatory clarity unlocked enterprise stablecoin volume this year.", source: SOURCE, amount: 0.01 }, cast);
    const stats = mod.juryStats();
    expect(stats.panels).toBe(1);
    expect(stats.claimsGraded).toBe(1);
    expect(mod.recentCertificates()).toHaveLength(1);
  });

  it("forcePanel convenes the diverse panel even on a claim the numeric floor cleared", async () => {
    let convened = 0;
    const spy = async (m: string, claim: string): Promise<Ballot> => { convened++; return ballot(m, "SUPPORTED"); };
    const r = await mod.runJury({ answer: "Regulatory clarity unlocked enterprise stablecoin volume this year.", source: SOURCE, amount: 0.01, forcePanel: true }, spy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.certificate.claims[0].escalated).toBe(true);
    expect(r.certificate.claims[0].ballots.length).toBeGreaterThan(0);
    expect(convened).toBeGreaterThan(0);
    expect(r.certificate.ballotCount).toBeGreaterThan(0);
    expect(r.certificate.merkleRoot).not.toBe(`0x${"0".repeat(64)}`);
  });

  it("forcePanel still lets the numeric floor refuse a fabricated figure without a panel", async () => {
    let convened = false;
    const spy = async (m: string, claim: string): Promise<Ballot> => { convened = true; return ballot(m, "SUPPORTED"); };
    const r = await mod.runJury({ answer: "Cross-border settlement hit $40T in annualized volume this year.", source: SOURCE, amount: 0.01, forcePanel: true }, spy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.certificate.claims[0].verdict).toBe("REFUSED");
    expect(r.certificate.claims[0].escalated).toBe(false);
    expect(convened).toBe(false);
  });

  it("rejects missing input", async () => {
    const r = await mod.runJury({ source: SOURCE, amount: 0.01 }, cast);
    expect(r.ok).toBe(false);
  });

  // ---- review-driven hardening ----

  it("clamps a caller threshold of 0 so the panel cannot stamp SUPPORTED regardless of votes", async () => {
    // With a real 1-support / rest-refuted panel, threshold:0 would (unclamped) force SUPPORTED. Clamped to ≥0.5.
    const mostlyRefute = async (m: string): Promise<Ballot> => ballot(m, m === "deepseek-v4-flash" ? "SUPPORTED" : "REFUTED");
    const r = await mod.runJury({ claim: "Enterprise stablecoin volume grew this year.", source: SOURCE, amount: 0.01, threshold: 0, forcePanel: true }, mostlyRefute);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.certificate.threshold).toBeGreaterThanOrEqual(0.5);
    expect(r.certificate.claims[0].verdict).toBe("REFUSED"); // 1/5 support < 0.5 clamp
  });

  it("rejects a roster below the diversity floor (no self-clearing single-model panel)", async () => {
    const r = await mod.runJury({ claim: "Enterprise stablecoin volume grew this year.", source: SOURCE, amount: 0.01, models: ["deepseek-v4-flash"] }, cast);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
  });

  it("caps a non-finite / absurd amount and never lets graded exceed the authorized amount", async () => {
    const inf = await mod.runJury({ claim: "x", source: SOURCE, amount: Number.POSITIVE_INFINITY }, cast);
    expect(inf.ok).toBe(false); // non-finite rejected

    const huge = await mod.runJury({ answer: "Regulatory clarity unlocked enterprise stablecoin volume this year.", source: SOURCE, amount: 1e9 }, cast);
    expect(huge.ok).toBe(true);
    if (!huge.ok) return;
    expect(huge.certificate.tally.gradedUsdc).toBeLessThanOrEqual(100); // MAX_AMOUNT cap
  });

  it("per-claim shares sum EXACTLY to the amount (no rounding drift above it)", async () => {
    // amount=0.02 over 3 claims all passing: naive per-claim rounding would overshoot to 0.020001; the remainder
    // allocation must keep the total ≤ amount and exactly equal when all pass.
    const answer = "Cross-border settlement crossed four trillion in annualized volume. Regulatory clarity unlocked enterprise volume. Embedded wallets drove consumer usage.";
    const r = await mod.runJury({ answer, source: SOURCE, amount: 0.02 }, cast);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.certificate.tally.totalClaims).toBe(3);
    expect(r.certificate.tally.gradedUsdc).toBeLessThanOrEqual(0.02 + 1e-9);
    expect(r.certificate.tally.gradedUsdc).toBeCloseTo(0.02, 6); // all pass → exactly the amount
  });
});

describe("decomposeClaims keeps short figure-bearing claims", () => {
  it("does not drop a 3-word claim that carries a figure", () => {
    const claims = mod.decomposeClaims("Revenue fell 40%. Adoption expanded across enterprise segments broadly this year.");
    expect(claims.some((c) => /40%/.test(c))).toBe(true);
  });
});
