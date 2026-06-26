import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordExternalHire, externalHires, _resetHiresCache } from "../lib/hires";

const TMP = path.join(os.tmpdir(), "merit-hires-test-" + process.pid);

describe("external-hire log (Bet 2 — the unfakeable traction signal)", () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    process.env.MERIT_DATA_DIR = TMP;
    _resetHiresCache();
  });
  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    delete process.env.MERIT_DATA_DIR;
  });

  it("counts hires monotonically and tracks distinct external principals", () => {
    recordExternalHire({ principalId: "p1", principalName: "agent-a", released: 0.05, at: 1 });
    recordExternalHire({ principalId: "p2", principalName: "agent-b", released: 0.03, at: 2 });
    recordExternalHire({ principalId: "p1", principalName: "agent-a", released: 0.02, at: 3 });
    const h = externalHires();
    expect(h.count).toBe(3);
    expect(h.distinctPrincipals).toBe(2); // p1, p2 — the number a wash-trading judge can't dismiss
    expect(h.totalReleased).toBeCloseTo(0.1, 6);
    expect(h.recent).toHaveLength(3);
  });

  it("persists across a cache reset", () => {
    recordExternalHire({ principalId: "p1", principalName: "a", released: 0.01, at: 1 });
    _resetHiresCache();
    expect(externalHires().count).toBe(1);
  });
});
