import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let dir: string;
let guard: typeof import("../lib/guard");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-guard-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  process.env.MERIT_DAILY_SPEND_CAP = "0.1";
  process.env.MERIT_SPEND_VELOCITY_WINDOW_MS = "1000";
  process.env.MERIT_SPEND_VELOCITY_CAP = "1.0"; // high — won't trip during the daily-cap test
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
  guard = await import("../lib/guard");
});
afterAll(() => vi.useRealTimers());

describe("operator safety guard (Wave C #8)", () => {
  it("allows spend within the daily cap, blocks past it", () => {
    const now = Date.now();
    expect(guard.canSpend(0.05, now).ok).toBe(true);
    guard.recordSpend(0.05, now);
    guard.recordSpend(0.05, now); // spentToday = 0.10 = the cap
    expect(guard.guardStatus(now).spentToday).toBeCloseTo(0.1, 6);
    expect(guard.canSpend(0.01, now).ok).toBe(false); // over the daily cap
    expect(guard.canSpend(0.01, now).reason).toMatch(/daily spend cap/);
    expect(guard.isFrozen()).toBe(false); // velocity cap (1.0) not tripped
  });

  it("clears the daily window after 24h", () => {
    vi.setSystemTime(new Date("2026-02-02T01:00:00Z")); // +25h
    const now = Date.now();
    expect(guard.guardStatus(now).spentToday).toBe(0); // old spends aged out
    expect(guard.canSpend(0.05, now).ok).toBe(true);
  });

  it("auto-freezes when spend velocity spikes past the window cap", () => {
    process.env.MERIT_SPEND_VELOCITY_CAP = "0.03"; // read dynamically per call
    const now = Date.now();
    guard.recordSpend(0.05, now); // 0.05 > 0.03 within the 1s window → circuit breaker trips
    expect(guard.isFrozen()).toBe(true);
    const s = guard.guardStatus(now);
    expect(s.frozen).toBe(true);
    expect(s.by).toBe("auto");
    expect(s.reason).toMatch(/velocity/);
    // frozen → nothing settles, regardless of caps
    expect(guard.canSpend(0.0001, now).ok).toBe(false);
  });

  it("reserveSpend atomically checks + records; releaseReservation rolls back (closes the TOCTOU)", () => {
    process.env.MERIT_SPEND_VELOCITY_CAP = "1.0"; // don't trip velocity here
    guard.unfreeze("op");
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z")); // fresh daily window
    const now = Date.now();
    const a = guard.reserveSpend(0.04, now);
    expect(a.ok).toBe(true);
    expect(guard.guardStatus(now).spentToday).toBeCloseTo(0.04, 6); // recorded immediately (before any settle await)
    const b = guard.reserveSpend(0.04, now);
    expect(b.ok).toBe(true); // 0.08 <= 0.10
    expect(guard.reserveSpend(0.04, now).ok).toBe(false); // 0.12 > 0.10 — a concurrent caller is correctly blocked
    guard.releaseReservation(a.id!); // the first settle failed → roll it back
    expect(guard.guardStatus(now).spentToday).toBeCloseTo(0.04, 6);
    expect(guard.reserveSpend(0.04, now).ok).toBe(true); // headroom freed
  });

  it("operator freeze / unfreeze toggles the kill-switch", () => {
    guard.unfreeze("op");
    expect(guard.isFrozen()).toBe(false);
    guard.freeze("manual halt", "op");
    expect(guard.isFrozen()).toBe(true);
    expect(guard.canSpend(0.0001, Date.now()).ok).toBe(false);
    expect(guard.guardStatus(Date.now()).reason).toBe("manual halt");
    guard.unfreeze("op");
    expect(guard.canSpend(0.0001, Date.now()).ok).toBe(true);
  });
});
