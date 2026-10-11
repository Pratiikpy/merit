import { describe, it, expect } from "vitest";
import { checkAutonomousCaps, spentInLast24h, AUTONOMOUS_BACKLOG, type AutonomousTick } from "../lib/autonomous";

function tick(overrides: Partial<AutonomousTick> = {}): AutonomousTick {
  return {
    id: "t",
    backlogIndex: 0,
    question: "q",
    budget: 0.02,
    startedAt: new Date().toISOString(),
    treasuryBefore: 1,
    treasuryAfter: 1,
    spent: 0.02,
    outcome: "ok",
    ...overrides,
  };
}

describe("the autonomous loop's backlog", () => {
  it("is a real, non-empty, non-trivial list of falsifiable questions", () => {
    expect(AUTONOMOUS_BACKLOG.length).toBeGreaterThan(5);
    for (const q of AUTONOMOUS_BACKLOG) {
      expect(q.length).toBeGreaterThan(20); // not a filler one-liner
      expect(q.trim().endsWith("?")).toBe(true); // a real question, not a statement
    }
  });
});

describe("spentInLast24h", () => {
  const now = Date.now();
  it("sums only 'ok' ticks inside the rolling 24h window", () => {
    const ticks = [
      tick({ spent: 0.01, startedAt: new Date(now - 1000).toISOString(), outcome: "ok" }),
      tick({ spent: 0.02, startedAt: new Date(now - 25 * 3600 * 1000).toISOString(), outcome: "ok" }), // too old
      tick({ spent: 0.5, startedAt: new Date(now - 1000).toISOString(), outcome: "skipped" }), // not ok
      tick({ spent: 0.5, startedAt: new Date(now - 1000).toISOString(), outcome: "error" }), // not ok
    ];
    expect(spentInLast24h(ticks, now)).toBe(0.01);
  });

  it("is 0 for an empty history", () => {
    expect(spentInLast24h([], now)).toBe(0);
  });
});

describe("checkAutonomousCaps — the real-money safety gate, tested without a chain or an LLM", () => {
  const now = Date.now();

  it("allows a tick when the treasury and the rolling spend both have headroom", () => {
    const r = checkAutonomousCaps({ treasuryBefore: 1, ticksSoFar: [], now, tickBudget: 0.02, dailyCap: 0.3, reserveFloor: 0.1 });
    expect(r.allowed).toBe(true);
  });

  it("refuses when the reserve floor would be breached, even with plenty of daily-cap headroom left", () => {
    const r = checkAutonomousCaps({ treasuryBefore: 0.11, ticksSoFar: [], now, tickBudget: 0.02, dailyCap: 0.3, reserveFloor: 0.1 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/reserve floor/);
  });

  it("refuses when the rolling-24h cap would be breached, even with a well-funded treasury", () => {
    const ticksSoFar = [tick({ spent: 0.29, startedAt: new Date(now - 1000).toISOString() })];
    const r = checkAutonomousCaps({ treasuryBefore: 100, ticksSoFar, now, tickBudget: 0.02, dailyCap: 0.3, reserveFloor: 0.1 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/daily cap/);
  });

  it("a tick right at the exact floor/cap boundary is allowed (strict less-than, not less-than-or-equal)", () => {
    // treasuryBefore - tickBudget === reserveFloor exactly: not BELOW the floor, so allowed.
    const atFloor = checkAutonomousCaps({ treasuryBefore: 0.12, ticksSoFar: [], now, tickBudget: 0.02, dailyCap: 0.3, reserveFloor: 0.1 });
    expect(atFloor.allowed).toBe(true);
    // spent24h + tickBudget === dailyCap exactly: not OVER the cap, so allowed.
    const atCap = checkAutonomousCaps({ treasuryBefore: 100, ticksSoFar: [tick({ spent: 0.28 })], now, tickBudget: 0.02, dailyCap: 0.3, reserveFloor: 0.1 });
    expect(atCap.allowed).toBe(true);
  });

  it("an unreadable treasury (handled by the caller, not this function) is a separate skip path — this function always needs a real number", () => {
    // checkAutonomousCaps itself never sees null; lib/autonomous.ts's runAutonomousTick short-circuits
    // on a null treasury balance before ever calling this. Documented here so the two paths aren't conflated.
    const r = checkAutonomousCaps({ treasuryBefore: 0, ticksSoFar: [], now, tickBudget: 0.02, dailyCap: 0.3, reserveFloor: 0.1 });
    expect(r.allowed).toBe(false); // 0 - 0.02 < reserveFloor
  });
});
