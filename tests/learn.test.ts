import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordSettlement, _resetHistoryCache } from "../lib/history";
import {
  recordAppeal,
  calibratedConfidence,
  confidenceMultiplier,
  reliability,
  evidenceCount,
  reflection,
  globalCalibration,
  _resetLearnCache,
} from "../lib/learn";

const TMP = path.join(os.tmpdir(), "merit-learn-test-" + process.pid);

describe("self-improving Auditor (lib/learn) — calibrates payout from outcomes, never the decision", () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    process.env.MERIT_DATA_DIR = TMP;
    delete process.env.LEARN;
    _resetLearnCache();
    _resetHistoryCache();
  });
  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    delete process.env.MERIT_DATA_DIR;
  });

  it("REGRESSION GATE: an unseen source's confidence is returned unchanged (multiplier 1.0)", () => {
    expect(confidenceMultiplier("unseen")).toBe(1.0);
    expect(calibratedConfidence(0.8, "unseen")).toBeCloseTo(0.8, 10);
    expect(evidenceCount("unseen")).toBe(0);
  });

  it("stays neutral below the minimum evidence threshold", () => {
    recordAppeal("s1", false); // 1 appeal → weight 2, under the 3-observation floor
    expect(confidenceMultiplier("s1")).toBe(1.0);
  });

  it("DISCOUNTS a source proven unreliable by overturned appeals — the learning curve", () => {
    expect(confidenceMultiplier("flaky")).toBe(1.0); // starts neutral
    recordAppeal("flaky", false);
    recordAppeal("flaky", false); // 2 overturned → weight 4 ≥ floor, reliability < 0.5
    const after = confidenceMultiplier("flaky");
    expect(after).toBeLessThan(1.0);
    expect(after).toBeGreaterThanOrEqual(0.5); // never below the floor
    expect(calibratedConfidence(0.8, "flaky")).toBeLessThan(0.8); // the flaky source earns less
    recordAppeal("flaky", false);
    recordAppeal("flaky", false);
    expect(confidenceMultiplier("flaky")).toBeLessThanOrEqual(after); // more overturns → lower still (monotone)
  });

  it("does NOT penalize a source upheld on appeal (reliability ≥ 0.5 → multiplier 1.0)", () => {
    recordAppeal("good", true);
    recordAppeal("good", true);
    expect(reliability("good")).toBeGreaterThan(0.5);
    expect(confidenceMultiplier("good")).toBe(1.0);
  });

  it("blends in settlement history — repeat refusals lower reliability", () => {
    for (let i = 0; i < 4; i++)
      recordSettlement({ runId: "r" + i, sourceId: "h", cited: true, released: false, amount: 0, confidence: 0.2, reason: "unsupported", at: 1 });
    _resetHistoryCache();
    expect(reliability("h")).toBeLessThan(0.5);
    expect(confidenceMultiplier("h")).toBeLessThan(1.0);
  });

  it("LEARN=0 disables calibration entirely (master off-switch)", () => {
    recordAppeal("flaky2", false);
    recordAppeal("flaky2", false);
    process.env.LEARN = "0";
    expect(confidenceMultiplier("flaky2")).toBe(1.0);
    expect(calibratedConfidence(0.8, "flaky2")).toBeCloseTo(0.8, 10);
    delete process.env.LEARN;
  });

  it("reflection summarizes the record; globalCalibration aggregates appeals", () => {
    recordAppeal("r1", true);
    recordAppeal("r1", false);
    expect(reflection("unseen2")).toContain("no track record");
    expect(reflection("r1")).toContain("appeals upheld");
    const g = globalCalibration();
    expect(g).toMatchObject({ appeals: 2, upheld: 1, overturned: 1 });
    expect(g.upheldRate).toBeCloseTo(0.5, 5);
  });
});
