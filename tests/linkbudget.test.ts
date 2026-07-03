import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let dir: string;
let lb: typeof import("../lib/linkbudget");

const T = 1_700_000_000_000; // fixed base timestamp (ms)

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-linkbudget-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE; // local-file store
  process.env.STUB = "1";
  process.env.MERIT_LINK_MAX_USDC = "0.1"; // window cap
  process.env.MERIT_LINK_MAX_SETTLE = "0.05"; // per-settle cap
  lb = await import("../lib/linkbudget");
});

describe("public Merit Link toll budget", () => {
  it("reads the caps from env", () => {
    expect(lb.windowCap()).toBeCloseTo(0.1, 6);
    expect(lb.perSettleCap()).toBeCloseTo(0.05, 6);
  });

  it("allows a settle within both caps on a fresh window", () => {
    expect(lb.spentInWindow(T)).toBe(0);
    expect(lb.remainingInWindow(T)).toBeCloseTo(0.1, 6);
    expect(lb.canSettle(0.03, T)).toBe(true);
    expect(lb.canSettle(0.05, T)).toBe(true); // exactly the per-settle cap
    expect(lb.canSettle(0.06, T)).toBe(false); // above the per-settle cap
    expect(lb.canSettle(0, T)).toBe(false); // non-positive never settles
    expect(lb.canSettle(-1, T)).toBe(false);
  });

  it("accumulates spend against the window cap and refuses once exhausted", () => {
    lb.recordSettle(0.05, T);
    lb.recordSettle(0.04, T);
    expect(lb.spentInWindow(T)).toBeCloseTo(0.09, 6);
    expect(lb.remainingInWindow(T)).toBeCloseTo(0.01, 6);
    expect(lb.canSettle(0.005, T)).toBe(true); // 0.095 ≤ 0.1
    expect(lb.canSettle(0.03, T)).toBe(false); // 0.12 > 0.1 window cap, even though 0.03 ≤ per-settle
  });

  it("only counts spend inside the trailing 24h window (prunes stale spend)", () => {
    const T2 = T + 25 * 60 * 60 * 1000; // 25h later — the earlier spends are now outside the window
    expect(lb.spentInWindow(T2)).toBe(0);
    expect(lb.canSettle(0.05, T2)).toBe(true); // window reset → full budget again
    lb.recordSettle(0.02, T2);
    expect(lb.spentInWindow(T2)).toBeCloseTo(0.02, 6);
    expect(lb.remainingInWindow(T2)).toBeCloseTo(0.08, 6);
  });

  it("ignores non-positive records", () => {
    const before = lb.spentInWindow(T);
    lb.recordSettle(0, T);
    lb.recordSettle(-5, T);
    expect(lb.spentInWindow(T)).toBe(before);
  });
});
