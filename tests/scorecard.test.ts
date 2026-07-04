import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import type { Scorecard } from "../lib/scorecard";

let dir: string;
let sc: typeof import("../lib/scorecard");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-scorecard-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE; // local-file store
  process.env.STUB = "1";
  sc = await import("../lib/scorecard");
});

function mk(over: Partial<Scorecard> = {}): Scorecard {
  return {
    id: Math.random().toString(36).slice(2, 12),
    url: "https://agent.example/api/answer",
    host: "agent.example",
    claim: "Stablecoin B2B settlement crossed $4.1T in 2026.",
    reachable: true,
    status: 200,
    tollPresent: false,
    priceUsdc: null,
    network: null,
    paid: false,
    paidUsdc: 0,
    tx: null,
    explorerUrl: null,
    verifiable: true,
    verdict: "SUPPORTED",
    quality: 0.9,
    valuePerDollar: null,
    methods: ["injection-guard", "numeric", "nli", "llm-judge"],
    reason: "verified — supports the claim.",
    createdAt: new Date(1).toISOString(),
    ...over,
  };
}

describe("endpoint scorecards", () => {
  it("saves, fetches by id, counts, and lists newest-first", () => {
    const before = sc.scorecardCount();
    const a = sc.saveScorecard(mk({ host: "a.example", createdAt: new Date(10).toISOString() }));
    const b = sc.saveScorecard(mk({ host: "b.example", createdAt: new Date(20).toISOString() }));
    expect(sc.scorecardCount()).toBe(before + 2);
    expect(sc.getScorecard(a.id)?.host).toBe("a.example");
    const recent = sc.listScorecards(2);
    expect(recent[0].id).toBe(b.id); // newest first
    expect(recent[1].id).toBe(a.id);
  });

  it("getScorecard returns undefined for unknown/empty id", () => {
    expect(sc.getScorecard("nope")).toBeUndefined();
    expect(sc.getScorecard("")).toBeUndefined();
  });

  // Leaderboard aggregation is per-host, so unique hostnames isolate each assertion from other tests' entries.
  it("ranks a host by mean verified-quality, counting only SUPPORTED as verified", () => {
    sc.saveScorecard(mk({ host: "rank-high.example", verdict: "SUPPORTED", quality: 0.95 }));
    sc.saveScorecard(mk({ host: "rank-high.example", verdict: "SUPPORTED", quality: 0.85 }));
    sc.saveScorecard(mk({ host: "rank-low.example", verdict: "REFUSED", quality: 0.05 }));
    const board = sc.leaderboard();
    const high = board.find((r) => r.host === "rank-high.example")!;
    const low = board.find((r) => r.host === "rank-low.example")!;
    expect(high.scored).toBe(2);
    expect(high.verified).toBe(2);
    expect(high.avgQuality).toBeCloseTo(0.9, 6);
    expect(low.verified).toBe(0);
    // the board is sorted by mean quality — a high-quality host ranks above a refusing one
    expect(board.findIndex((r) => r.host === "rank-high.example")).toBeLessThan(
      board.findIndex((r) => r.host === "rank-low.example"),
    );
  });

  it("honesty: value-per-dollar only reflects scorecards that actually PAID", () => {
    // an UNPAID verified card contributes quality but NO value-per-dollar
    sc.saveScorecard(mk({ host: "pay.example", paid: false, paidUsdc: 0, quality: 0.9, valuePerDollar: null }));
    // a PAID verified card carries a real value-per-dollar + a real tx
    sc.saveScorecard(
      mk({ host: "pay.example", paid: true, paidUsdc: 0.01, quality: 0.9, valuePerDollar: 90, tollPresent: true, priceUsdc: 0.01, status: 402, tx: "0xabc", explorerUrl: "https://x/tx/0xabc" }),
    );
    const row = sc.leaderboard().find((r) => r.host === "pay.example")!;
    expect(row.paidScorecards).toBe(1); // only the paid one counts as paid
    expect(row.bestValuePerDollar).toBeCloseTo(90, 6);
  });

  it("honesty: a terms-only (unverifiable) card carries no verdict and is excluded from avgQuality", () => {
    sc.saveScorecard(mk({ host: "toll.example", tollPresent: true, priceUsdc: 0.05, status: 402, paid: false, verifiable: false, verdict: null, quality: null, reason: "toll present — not paid" }));
    sc.saveScorecard(mk({ host: "toll.example", verifiable: true, verdict: "SUPPORTED", quality: 0.8 }));
    const row = sc.leaderboard().find((r) => r.host === "toll.example")!;
    expect(row.scored).toBe(2);
    expect(row.verified).toBe(1); // the unverifiable one is not counted as verified
    expect(row.avgQuality).toBeCloseTo(0.8, 6); // only the verifiable card contributes to mean quality
    expect(row.bestValuePerDollar).toBeNull(); // nothing was paid
  });
});
