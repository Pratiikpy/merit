import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordSettlement, _resetHistoryCache } from "../lib/history";
import { recordAppeal, _resetLearnCache } from "../lib/learn";
import { createApiKey, _resetAuthCache } from "../lib/auth";
import { snapshotMetrics } from "../lib/metrics";
import { getSources } from "../lib/registry";

const TMP = path.join(os.tmpdir(), "merit-metrics-test-" + process.pid);

describe("lib/metrics (live snapshot composition)", () => {
  beforeAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    process.env.MERIT_DATA_DIR = TMP;
    _resetHistoryCache();
    _resetLearnCache();
    _resetAuthCache();
  });
  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    delete process.env.MERIT_DATA_DIR;
  });

  it("composes sources, principals, calibration, settled total, and a leaderboard", () => {
    const id = getSources()[0]?.id;
    expect(id).toBeTruthy();
    recordSettlement({ runId: "r1", sourceId: id, cited: true, released: true, amount: 0.05, confidence: 0.8, reason: "released", at: 1 });
    recordAppeal(id, true);
    createApiKey("agent", 1);
    const m = snapshotMetrics();
    expect(m.sources).toBeGreaterThan(0);
    expect(m.principals).toBe(1);
    expect(m.calibration.appeals).toBe(1);
    expect(m.totalSettledUsdc).toBeCloseTo(0.05, 6);
    expect(m.leaderboard.find((x) => x.id === id)?.earned).toBeCloseTo(0.05, 6);
  });
});
