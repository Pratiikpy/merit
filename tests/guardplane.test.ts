import { describe, it, expect, beforeEach } from "vitest";
import { authorize, setPolicy, getPolicy, recordOverride, rollingExposure, guardStats, _resetGuardPlane } from "../lib/guardplane";

// The signed control plane: allow AND block are receipts; policy is admin-authored; exposure defeats salami-slicing.
beforeEach(() => _resetGuardPlane());

describe("guard authorize", () => {
  it("allows a clean small payment and records a signed-shape receipt", async () => {
    const r = await authorize({ principal: "agent-a", payee: "0x7C3aED000000000000000000000000000000AaAa", amountUsdc: 0.01 });
    expect(r.decision).toBe("allow");
    expect(r.reasons).toHaveLength(0);
    expect(r.schema).toBe("merit.guard/v1");
    expect(r.receiptId).toMatch(/^0x/);
  });

  it("blocks over the per-tx cap with the policy version in the receipt", async () => {
    const r = await authorize({ principal: "agent-a", payee: "0x7C3aED000000000000000000000000000000AaAa", amountUsdc: 99 });
    expect(r.decision).toBe("block");
    expect(r.reasons.join(" ")).toMatch(/maxPerTxUsdc/);
    expect(r.policyVersion).toBe(getPolicy().version);
  });

  it("blocks an invalid request (no payee / non-positive amount)", async () => {
    expect((await authorize({ principal: "a", payee: "", amountUsdc: 0.01 })).decision).toBe("block");
    expect((await authorize({ principal: "a", payee: "0xAbC", amountUsdc: 0 })).decision).toBe("block");
  });

  it("SALAMI-SLICING: many sub-cap payments to one payee hit the rolling window", async () => {
    const payee = "0x7C3aED000000000000000000000000000000BbBb";
    const t0 = Date.now();
    // policy default: maxPerTxUsdc 0.25, maxPerPayeeWindowUsdc 1, window 24h → five 0.24s pass (1.20 > 1 blocks the 5th)
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) outcomes.push((await authorize({ principal: "a", payee, amountUsdc: 0.24, now: t0 + i })).decision);
    expect(outcomes.slice(0, 4)).toEqual(["allow", "allow", "allow", "allow"]);
    expect(outcomes[4]).toBe("block"); // each alone is under the per-tx cap; the WINDOW catches the pattern
    expect(rollingExposure(payee, 24, t0 + 10)).toBeCloseTo(0.96, 6);
  });

  it("the window slides — old exposure expires", async () => {
    const payee = "0x7C3aED000000000000000000000000000000CcCc";
    const t0 = Date.now();
    await authorize({ principal: "a", payee, amountUsdc: 0.24, now: t0 });
    expect(rollingExposure(payee, 24, t0 + 25 * 3600_000)).toBe(0); // 25h later, outside the 24h window
  });
});

describe("policy (anti self-escalation surface)", () => {
  it("versions monotonically and carries updatedBy=admin", async () => {
    const v1 = getPolicy().version;
    const p = await setPolicy({ maxPerTxUsdc: 0.5 });
    expect(p.version).toBe(v1 + 1);
    expect(p.updatedBy).toBe("admin");
    expect(p.maxPerTxUsdc).toBe(0.5);
    expect(p.policyId).toMatch(/^0x/);
  });

  it("rejects nonsense values by falling back to current", async () => {
    const before = getPolicy().maxPerTxUsdc;
    const p = await setPolicy({ maxPerTxUsdc: -5 as unknown as number });
    expect(p.maxPerTxUsdc).toBe(before);
  });
});

describe("override (named-human accountability)", () => {
  it("chains to the blocked receipt and requires an operator name", async () => {
    const blocked = await authorize({ principal: "a", payee: "0x7C3aED000000000000000000000000000000DdDd", amountUsdc: 99 });
    expect(blocked.decision).toBe("block");
    const noName = await recordOverride({ blockedReceiptId: blocked.id, operator: "", reason: "x" });
    expect("error" in noName).toBe(true);
    const ok = await recordOverride({ blockedReceiptId: blocked.id, operator: "prateek", reason: "manual payroll exception" });
    if ("error" in ok) throw new Error("expected receipt");
    expect(ok.decision).toBe("override");
    expect(ok.overrides).toBe(blocked.id);
    expect(ok.operator).toBe("prateek");
  });

  it("cannot override an allow or a missing receipt", async () => {
    const allowed = await authorize({ principal: "a", payee: "0x7C3aED000000000000000000000000000000EeEe", amountUsdc: 0.01 });
    expect("error" in (await recordOverride({ blockedReceiptId: allowed.id, operator: "p", reason: "x" }))).toBe(true);
    expect("error" in (await recordOverride({ blockedReceiptId: "nope", operator: "p", reason: "x" }))).toBe(true);
  });
});

describe("stats", () => {
  it("counts allowed/blocked/overrides and blocked USDC", async () => {
    await authorize({ principal: "a", payee: "0x7C3aED000000000000000000000000000000FfFf", amountUsdc: 0.01 });
    const b = await authorize({ principal: "a", payee: "0x7C3aED000000000000000000000000000000FfFf", amountUsdc: 50 });
    await recordOverride({ blockedReceiptId: b.id, operator: "p", reason: "test" });
    const s = guardStats();
    expect(s.allowed).toBe(1);
    expect(s.blocked).toBe(1);
    expect(s.overrides).toBe(1);
    expect(s.blockedUsdc).toBe(50);
  });
});
