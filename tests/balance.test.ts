import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let dir: string;
let bal: typeof import("../lib/balance");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-balance-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE;
  process.env.STUB = "1"; // simulated deposits + no real chain
  bal = await import("../lib/balance");
});

describe("prepaid verification balance", () => {
  it("reports zeros for an unknown principal and refuses to charge with no funds", () => {
    expect(bal.balanceStatus("prin_none")).toEqual({ funded: 0, spent: 0, withdrawn: 0, available: 0, charges: 0, refusedNoCharge: 0 });
    expect(bal.available("prin_none")).toBe(0);
    expect(bal.chargeVerified("prin_none", 0.005).ok).toBe(false);
  });

  it("burns down ONLY on verified citations; refused ones cost nothing", () => {
    const id = "prin_a";
    const dep = bal.simulateDeposit(id, 0.05);
    expect("credited" in dep && dep.credited).toBe(0.05);
    expect(bal.available(id)).toBeCloseTo(0.05, 6);

    // 3 verified charges at 0.005
    for (let i = 0; i < 3; i++) expect(bal.chargeVerified(id, 0.005).ok).toBe(true);
    // 2 refusals — no charge
    bal.noteRefused(id);
    bal.noteRefused(id);

    const s = bal.balanceStatus(id);
    expect(s.funded).toBeCloseTo(0.05, 6);
    expect(s.spent).toBeCloseTo(0.015, 6); // only the 3 verified
    expect(s.available).toBeCloseTo(0.035, 6);
    expect(s.charges).toBe(3);
    expect(s.refusedNoCharge).toBe(2); // stayed in the balance
  });

  it("refuses a charge that exceeds the available balance (no overspend)", () => {
    const id = "prin_b";
    bal.simulateDeposit(id, 0.01);
    expect(bal.chargeVerified(id, 0.02).ok).toBe(false); // more than funded
    expect(bal.chargeVerified(id, 0.01).ok).toBe(true); // exactly available
    expect(bal.chargeVerified(id, 0.0001).ok).toBe(false); // now empty
    expect(bal.available(id)).toBe(0);
  });

  it("credits the exact simulated amount and is additive", () => {
    const id = "prin_c";
    bal.simulateDeposit(id, 0.02);
    bal.simulateDeposit(id, 0.03);
    expect(bal.balanceStatus(id).funded).toBeCloseTo(0.05, 6);
  });

  it("gives each principal a UNIQUE, deterministic deposit address (no shared wallet → no cross-principal theft)", () => {
    const a1 = bal.depositAddressFor("prin_x");
    const a2 = bal.depositAddressFor("prin_y");
    expect(a1).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a1).not.toBe(a2); // distinct per principal
    expect(bal.depositAddressFor("prin_x")).toBe(a1); // deterministic
  });

  it("on-chain deposit + withdrawal are unavailable in stub (never fake real money)", async () => {
    const d = await bal.creditDeposit("prin_d", "0x" + "a".repeat(64));
    expect("error" in d).toBe(true);
    const w = await bal.withdrawBalance("prin_a", "0x415Fb8814084bDBC7B6964620Ba5Be5939aD2333");
    expect("error" in w).toBe(true); // keyless/stub → no real withdrawal
  });
});
