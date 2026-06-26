import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { recordSettlement, readHistory, historyStats, learnedTrust, _resetHistoryCache } from "../lib/history";

const rec = (over: Partial<Parameters<typeof recordSettlement>[0]> = {}) => ({
  runId: "r", sourceId: "s", cited: true, released: true, amount: 0.01, confidence: 0.7, reason: "ok", at: 1, ...over,
});

describe("history store (cross-run settlement memory)", () => {
  beforeEach(() => {
    // Point the store at a fresh temp dir per test, then drop the cache so it reloads empty.
    process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-hist-"));
    _resetHistoryCache();
  });

  it("records and reads back newest-last", () => {
    for (let i = 0; i < 3; i++) recordSettlement(rec({ runId: "r" + i, sourceId: "s1", at: i }));
    const h = readHistory("s1");
    expect(h).toHaveLength(3);
    expect(h[2].runId).toBe("r2"); // newest last
  });

  it("computes release rate, avg confidence, and total earned", () => {
    recordSettlement(rec({ sourceId: "s2", released: true, amount: 0.02, confidence: 0.8 }));
    recordSettlement(rec({ sourceId: "s2", released: false, amount: 0, confidence: 0.2 }));
    const st = historyStats("s2");
    expect(st.runs).toBe(2);
    expect(st.releaseRate).toBe(0.5);
    expect(st.avgConfidence).toBeCloseTo(0.5, 5);
    expect(st.totalEarned).toBeCloseTo(0.02, 5);
  });

  it("release rate counts only CITED records as the denominator", () => {
    recordSettlement(rec({ sourceId: "s3", cited: true, released: true }));
    recordSettlement(rec({ sourceId: "s3", cited: false, released: false })); // un-cited: not a refusal of THIS source
    expect(historyStats("s3").releaseRate).toBe(1); // 1 of 1 cited released
  });

  it("returns zeros for a source with no history", () => {
    expect(historyStats("unknown")).toEqual({ runs: 0, releaseRate: 0, avgConfidence: 0, totalEarned: 0 });
    expect(readHistory("unknown")).toEqual([]);
  });
});

describe("learnedTrust (Bayesian cross-run trust, #11)", () => {
  beforeEach(() => {
    process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-trust-"));
    _resetHistoryCache();
  });
  it("an unseen source is neutral (0.5)", () => {
    expect(learnedTrust("nobody")).toBe(0.5);
  });
  it("rises for a consistent earner, sinks for a repeat mis-citer (converges to the release rate)", () => {
    for (let i = 0; i < 5; i++) recordSettlement(rec({ sourceId: "good", cited: true, released: true }));
    for (let i = 0; i < 5; i++) recordSettlement(rec({ sourceId: "bad", cited: true, released: false }));
    expect(learnedTrust("good")).toBeCloseTo(6 / 7, 5); // (5+1)/(5+2)
    expect(learnedTrust("bad")).toBeCloseTo(1 / 7, 5); // (0+1)/(5+2)
    expect(learnedTrust("good")).toBeGreaterThan(0.5);
    expect(learnedTrust("bad")).toBeLessThan(0.5);
  });
});
