import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordLedgerSettlement, ledgerTotals, ledgerHistory, distinctPayees, _resetLedgerCache } from "../lib/ledger";

const TMP = path.join(os.tmpdir(), "merit-ledger-test-" + process.pid);

describe("append-only monotonic settlement ledger (Bet 3)", () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    process.env.MERIT_DATA_DIR = TMP;
    _resetLedgerCache();
  });
  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    delete process.env.MERIT_DATA_DIR;
  });

  it("accumulates monotonically and tracks distinct payees + runs", () => {
    recordLedgerSettlement({ runId: "r1", sourceId: "a", amount: 0.01, at: 1 });
    recordLedgerSettlement({ runId: "r1", sourceId: "b", amount: 0.02, at: 2 });
    recordLedgerSettlement({ runId: "r2", sourceId: "a", amount: 0.03, at: 3 });
    const c = ledgerTotals();
    expect(c.totalSettledUsdc).toBeCloseTo(0.06, 6);
    expect(c.settlementCount).toBe(3);
    expect(distinctPayees()).toBe(2);
    expect(c.runCount).toBe(2);
    expect(c.firstAt).toBe(1);
    expect(c.lastAt).toBe(3);
  });

  it("ignores zero/negative amounts (only money-moved settlements count)", () => {
    recordLedgerSettlement({ runId: "r1", sourceId: "a", amount: 0, at: 1 });
    recordLedgerSettlement({ runId: "r1", sourceId: "a", amount: -1, at: 1 });
    expect(ledgerTotals().totalSettledUsdc).toBe(0);
    expect(ledgerTotals().settlementCount).toBe(0);
  });

  it("THE KEY PROPERTY: the cumulative never falls when the entries tail is capped", () => {
    for (let i = 0; i < 1200; i++) recordLedgerSettlement({ runId: "r" + i, sourceId: "s" + (i % 3), amount: 0.001, at: i });
    const c = ledgerTotals();
    expect(c.settlementCount).toBe(1200); // monotonic count — NOT capped with the entries
    expect(c.totalSettledUsdc).toBeCloseTo(1.2, 5);
    expect(distinctPayees()).toBe(3);
    expect(ledgerHistory(50)).toHaveLength(50); // the time-series tail IS capped, but the total isn't
  });

  it("persists across a cache reset (reload from disk keeps the total)", () => {
    recordLedgerSettlement({ runId: "r1", sourceId: "a", amount: 0.05, at: 1 });
    _resetLedgerCache();
    expect(ledgerTotals().totalSettledUsdc).toBeCloseTo(0.05, 6);
  });
});
