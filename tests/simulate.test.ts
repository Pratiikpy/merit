import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

let mod: typeof import("../lib/simulate");

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

beforeEach(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-sim-"));
  process.env.STUB = "1";
  mod = await import("../lib/simulate");
});

describe("decideSim (pure pre-flight decision)", () => {
  it("passes with sufficient balance, no revert, and gas", () => {
    const d = mod.decideSim({ balanceUsdc: 10, requiredUsdc: 5, reverted: false, hasNativeForGas: true });
    expect(d.wouldSucceed).toBe(true);
  });

  it("fails on insufficient balance", () => {
    const d = mod.decideSim({ balanceUsdc: 1, requiredUsdc: 5, reverted: false, hasNativeForGas: true });
    expect(d.wouldSucceed).toBe(false);
    expect(d.reason).toContain("insufficient");
  });

  it("fails when the dry-run reverts", () => {
    const d = mod.decideSim({ balanceUsdc: 10, requiredUsdc: 5, reverted: true, hasNativeForGas: true });
    expect(d.wouldSucceed).toBe(false);
    expect(d.reason).toContain("revert");
  });

  it("fails when the sender can't pay gas", () => {
    const d = mod.decideSim({ balanceUsdc: 10, requiredUsdc: 5, reverted: false, hasNativeForGas: false });
    expect(d.wouldSucceed).toBe(false);
    expect(d.reason).toContain("gas");
  });

  it("rejects a non-positive amount", () => {
    expect(mod.decideSim({ balanceUsdc: 10, requiredUsdc: 0, reverted: false, hasNativeForGas: true }).wouldSucceed).toBe(false);
  });

  it("accepts an exact-balance transfer (boundary)", () => {
    expect(mod.decideSim({ balanceUsdc: 5, requiredUsdc: 5, reverted: false, hasNativeForGas: true }).wouldSucceed).toBe(true);
  });
});

describe("simulateUsdcTransfer (non-blocking when it can't run)", () => {
  it("STUB mode: not simulated, and does NOT block (wouldSucceed true)", async () => {
    const r = await mod.simulateUsdcTransfer({ from: FROM, to: TO, amount: 1 });
    expect(r.simulated).toBe(false);
    expect(r.wouldSucceed).toBe(true); // an un-runnable pre-check must never block a real settlement
    expect(r.reason).toContain("STUB");
  });

  it("a malformed address is not simulated and does not block", async () => {
    const r = await mod.simulateUsdcTransfer({ from: "bad", to: TO, amount: 1 });
    expect(r.simulated).toBe(false);
    expect(r.wouldSucceed).toBe(true);
  });

  it("a non-positive amount is a hard, simulated failure", async () => {
    const r = await mod.simulateUsdcTransfer({ from: FROM, to: TO, amount: 0 });
    expect(r.simulated).toBe(true);
    expect(r.wouldSucceed).toBe(false);
  });

  it("reports the required amount and chain honestly", async () => {
    const r = await mod.simulateUsdcTransfer({ from: FROM, to: TO, amount: 2.5 });
    expect(r.requiredUsdc).toBe(2.5);
    expect(r.chainId).toBe(5042002);
  });
});
