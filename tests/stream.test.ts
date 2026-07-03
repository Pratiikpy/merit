import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

let mod: typeof import("../lib/stream");

beforeAll(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-stream-"));
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  mod = await import("../lib/stream");
});
beforeEach(() => mod._resetStreams());

describe("verified streaming (RFB-4) — pay-per-verified-tick", () => {
  it("opens a stream and releases only on passing ticks, tracking spend against the cap", async () => {
    const s = mod.openStream("p1", { ratePerTick: 0.001, cap: 0.005 });
    expect(s.ratePerTick).toBe(0.001);
    expect(s.cap).toBe(0.005);
    expect(mod.streamView(s)).toMatchObject({ spent: 0, released: 0, halted: false, live: true });

    const a = await mod.recordPass(s.id, "0xabc");
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.released).toBe(1);
    const v1 = mod.streamView(mod.getStream(s.id)!);
    expect(v1.spent).toBeCloseTo(0.001, 6);
    expect(v1.remaining).toBeCloseTo(0.004, 6);
    expect(v1.lastVerificationId).toBe("0xabc");
  });

  it("a failing tick HALTS the stream and charges nothing", async () => {
    const s = mod.openStream("p1", { ratePerTick: 0.001, cap: 0.01 });
    await mod.recordPass(s.id);
    mod.recordFail(s.id, "tick did not verify — source contradicts the chunk");
    const v = mod.streamView(mod.getStream(s.id)!);
    expect(v.halted).toBe(true);
    expect(v.failed).toBe(1);
    expect(v.live).toBe(false);
    expect(v.spent).toBeCloseTo(0.001, 6); // only the one passing tick was charged
    // no further ticks pass once halted
    expect((await mod.recordPass(s.id)).ok).toBe(false);
  });

  it("auto-halts when the cap is reached (never over-spends)", async () => {
    const s = mod.openStream("p1", { ratePerTick: 0.002, cap: 0.004 });
    expect((await mod.recordPass(s.id)).ok).toBe(true); // 0.002
    expect((await mod.recordPass(s.id)).ok).toBe(true); // 0.004 == cap
    const third = await mod.recordPass(s.id); // would exceed cap
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toMatch(/cap/i);
    const v = mod.streamView(mod.getStream(s.id)!);
    expect(v.halted).toBe(true);
    expect(v.spent).toBeCloseTo(0.004, 6);
    expect(v.released).toBe(2);
  });

  it("rollbackTick undoes a pass and halts (balance-race safety)", async () => {
    const s = mod.openStream("p1", { ratePerTick: 0.001, cap: 0.01 });
    await mod.recordPass(s.id);
    await mod.recordPass(s.id);
    mod.rollbackTick(s.id, "prepaid balance exhausted mid-tick");
    const v = mod.streamView(mod.getStream(s.id)!);
    expect(v.spent).toBeCloseTo(0.001, 6); // one pass undone
    expect(v.released).toBe(1);
    expect(v.halted).toBe(true);
  });

  it("close finalizes; a stream belongs to its principal only", async () => {
    const s = mod.openStream("owner", { ratePerTick: 0.001, cap: 0.01 });
    expect(mod.closeStream(s.id, "someone-else")).toBeNull(); // not yours
    const v = mod.closeStream(s.id, "owner");
    expect(v?.closed).toBe(true);
    expect(v?.live).toBe(false);
    // a closed stream takes no more ticks
    expect((await mod.recordPass(s.id)).ok).toBe(false);
    // pay-as-you-go: nothing reserved, so nothing to refund — you only paid for verified ticks
    expect(mod.listStreams("owner").length).toBe(1);
  });
});
