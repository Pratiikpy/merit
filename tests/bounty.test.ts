import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { recordBounty, readBounties, bountyStats, _resetBountyCache, type BountyEntry } from "../lib/bounty";

const entry = (over: Partial<BountyEntry> = {}): BountyEntry => ({
  source: "S", claim: "c", verdict: "REFUSED", fooled: false, by: "LLM judge", at: 1, ...over,
});

describe("bounty store + fool-rate (#8)", () => {
  beforeEach(() => {
    process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-bounty-"));
    _resetBountyCache();
  });

  it("records, reads newest-first, and computes the fool-rate", () => {
    recordBounty(entry({ verdict: "REFUSED", fooled: false }));
    recordBounty(entry({ verdict: "SUPPORTED", fooled: true, claim: "fool" }));
    const recent = readBounties();
    expect(recent[0].claim).toBe("fool"); // newest first
    expect(bountyStats()).toMatchObject({ total: 2, fooled: 1, held: 1 });
    expect(bountyStats().foolRate).toBe(0.5);
  });

  it("an empty board reports a 0 fool-rate", () => {
    expect(bountyStats()).toEqual({ total: 0, fooled: 0, held: 0, foolRate: 0 });
    expect(readBounties()).toEqual([]);
  });
});
