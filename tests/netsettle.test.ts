import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let mod: typeof import("../lib/netsettle");
import type { BatchLine } from "../lib/netsettle";

beforeAll(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-batch-"));
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  mod = await import("../lib/netsettle");
});

describe("verified net settlement — summarize (pure)", () => {
  it("nets a mixed basket to its settled subset and totals each bucket", () => {
    const lines: BatchLine[] = [
      { sourceName: "a", claim: "c1", amount: 0.01, verdict: "SUPPORTED", settled: true },
      { sourceName: "b", claim: "c2", amount: 0.02, verdict: "REFUSED", settled: false },
      { sourceName: "c", claim: "c3", amount: 0.005, verdict: "SUPPORTED", settled: true },
      { sourceName: "d", claim: "c4", amount: 0.03, verdict: "error", settled: false },
    ];
    const s = mod.summarize(lines);
    expect(s.count).toBe(4);
    expect(s.settledCount).toBe(2);
    expect(s.quarantinedCount).toBe(2);
    expect(s.totalAuthorized).toBeCloseTo(0.065, 6);
    expect(s.totalSettled).toBeCloseTo(0.015, 6);
    expect(s.totalQuarantined).toBeCloseTo(0.05, 6);
  });

  it("an all-quarantined basket settles nothing", () => {
    const s = mod.summarize([
      { sourceName: "x", claim: "c", amount: 0.01, verdict: "REFUSED", settled: false },
      { sourceName: "y", claim: "c", amount: 0.01, verdict: "REFUSED", settled: false },
    ]);
    expect(s.settledCount).toBe(0);
    expect(s.totalSettled).toBe(0);
    expect(s.totalQuarantined).toBeCloseTo(0.02, 6);
  });
});

describe("verified net settlement — settleVerifiedBatch (real engine, deterministic REFUSE path)", () => {
  it("quarantines every line whose claim the source contradicts, paying nothing", async () => {
    // Fabricated numeric claims are REFUSED deterministically by the numeric layer (no LLM/NLI needed) — the
    // honest floor: a line that does not verify never settles.
    const res = await mod.settleVerifiedBatch(
      [
        { sourceName: "SD", content: "Reports show the market reached $4.1 trillion in daily volume.", claim: "The market hit $40 trillion in daily volume.", amount: 0.01 },
        { sourceName: "CB", content: "Reports show adoption reached 5 million users.", claim: "Adoption reached 900 million users.", amount: 0.02 },
      ],
      { verify: { useNLI: false, useJudge: false } },
    );
    expect(res.count).toBe(2);
    expect(res.settledCount).toBe(0);
    expect(res.quarantinedCount).toBe(2);
    expect(res.totalSettled).toBe(0);
    expect(res.totalQuarantined).toBeCloseTo(0.03, 6);
    expect(res.lines.every((l) => l.verdict === "REFUSED" && !l.settled)).toBe(true);
    expect(res.lines.every((l) => typeof l.receiptId === "string")).toBe(true); // every line still mints a signed receipt
  });
});
