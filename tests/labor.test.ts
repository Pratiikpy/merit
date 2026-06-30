import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { recordLaborSettlement, laborTotals, setLaborLedger } from "../lib/labor";

describe("agent-labor market counter", () => {
  beforeEach(() => { process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-labor-")); setLaborLedger({ settlements: 0, volumeUsdc: 0, payers: [], specialists: [], lastAt: 0 }); });
  it("counts settlements, sums volume, and dedupes distinct agents + specialists", () => {
    recordLaborSettlement({ payer: "0xAAA", specialist: "scout", amount: 0.006 });
    recordLaborSettlement({ payer: "0xAAA", specialist: "ferret", amount: 0.003 }); // same agent, new specialist
    recordLaborSettlement({ payer: "0xBBB", specialist: "scout", amount: 0.006 }); // new agent
    const t = laborTotals();
    expect(t.settlements).toBe(3);
    expect(t.distinctAgents).toBe(2);
    expect(t.distinctSpecialists).toBe(2);
    expect(t.volumeUsdc).toBeCloseTo(0.015, 6);
  });
  it("ignores zero/negative amounts and 'unknown' payers", () => {
    recordLaborSettlement({ payer: "0xAAA", specialist: "scout", amount: 0 });
    recordLaborSettlement({ payer: "unknown", specialist: "scout", amount: 0.006 });
    const t = laborTotals();
    expect(t.settlements).toBe(1);     // the zero-amount one is dropped
    expect(t.distinctAgents).toBe(0);  // 'unknown' is not counted as a distinct agent
  });
});
