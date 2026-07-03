import { beforeAll, describe, expect, it } from "vitest";

// A well-known throwaway test key (never funded, never used in prod) so signing is deterministic here.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

let mod: typeof import("../lib/fulfillment");

beforeAll(async () => {
  process.env.STUB = "1";
  process.env.MERIT_SIGNING_KEY = TEST_KEY;
  mod = await import("../lib/fulfillment");
});

const base = {
  verificationId: "0x" + "ab".repeat(32),
  claim: "cross-border stablecoin settlement crossed trillions in 2026",
  amount: 0.0045,
  settledAt: "2026-07-03T00:00:00.000Z",
  sourceName: "StableData API",
  receiptId: "rcpt123",
};

describe("AP2 fulfillment credential", () => {
  it("mints a signed, offline-recoverable credential on a verified settlement", async () => {
    const cred = await mod.mintFulfillment(base);
    expect(cred.schema).toBe("merit.fulfillment/v1");
    expect(cred.fulfilled).toBe(true);
    expect(cred.verificationId).toBe(base.verificationId);
    expect(cred.amount).toBeCloseTo(0.0045, 6);
    expect(typeof cred.signature).toBe("string");
    const check = await mod.verifyFulfillment(cred as unknown as Record<string, unknown>);
    expect(check.ok).toBe(true);
    expect(check.recovered?.toLowerCase()).toBe(cred.signer?.toLowerCase());
  });

  it("binds the mandate it fulfills (AP2 loop)", async () => {
    const cred = await mod.mintFulfillment({ ...base, mandate: { authorizer: "0xauth", nonce: "n1" } });
    expect(cred.mandate).toEqual({ authorizer: "0xauth", nonce: "n1" });
    expect((await mod.verifyFulfillment(cred as unknown as Record<string, unknown>)).ok).toBe(true);
  });

  it("a tampered credential fails signature recovery", async () => {
    const cred = await mod.mintFulfillment(base);
    const tampered = { ...cred, amount: 999 }; // change the settled amount after signing
    expect((await mod.verifyFulfillment(tampered as unknown as Record<string, unknown>)).ok).toBe(false);
  });

  it("is deterministic — the same input signs to the same credential", async () => {
    const a = await mod.mintFulfillment(base);
    const b = await mod.mintFulfillment(base);
    expect(a.signature).toBe(b.signature);
    expect(a.signer).toBe(b.signer);
  });
});
