import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

let dir: string;
let mod: typeof import("../lib/mandate");
let account: ReturnType<typeof privateKeyToAccount>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-mandate-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  mod = await import("../lib/mandate");
  account = privateKeyToAccount(("0x" + "1".repeat(64)) as `0x${string}`);
});

function freshMandate(over: Partial<import("../lib/mandate").Mandate> = {}): import("../lib/mandate").Mandate {
  return {
    type: "citation-payment",
    authorizer: account.address,
    maxAmount: 0.05,
    scope: "citation",
    expiresAt: Date.now() + 3_600_000,
    nonce: "n_" + Math.round(account.address.length) + Object.keys(over).join(""),
    ...over,
  };
}
const sign = (m: import("../lib/mandate").Mandate) => account.signMessage({ message: mod.mandateMessage(m) });

describe("AP2-style signed mandate gate (biggest bet)", () => {
  it("accepts a valid, in-scope, in-cap, signed mandate", async () => {
    const m = freshMandate({ nonce: "ok-1" });
    const sig = await sign(m);
    const r = await mod.verifyMandate(m, sig, { amount: 0.03, scope: "citation" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.authorizer.toLowerCase()).toBe(account.address.toLowerCase());
      expect(r.remaining).toBeCloseTo(0.02, 6);
    }
  });

  it("rejects a wrong signer, wrong scope, expiry, and over-cap", async () => {
    const m = freshMandate({ nonce: "checks" });
    const sig = await sign(m);
    // a signature over a DIFFERENT mandate (tampered maxAmount) must not validate the original
    const tampered = { ...m, maxAmount: 999 };
    const tsig = await sign(m); // signed the original, but present the tampered body
    expect((await mod.verifyMandate(tampered, tsig, { amount: 0.03, scope: "citation" })).ok).toBe(false);
    // wrong scope
    expect((await mod.verifyMandate(m, sig, { amount: 0.03, scope: "research" })).ok).toBe(false);
    // expired
    const exp = freshMandate({ nonce: "exp", expiresAt: Date.now() - 1000 });
    expect((await mod.verifyMandate(exp, await sign(exp), { amount: 0.01, scope: "citation" })).ok).toBe(false);
    // over cap
    expect((await mod.verifyMandate(m, sig, { amount: 0.06, scope: "citation" })).ok).toBe(false);
    // garbage signature
    expect((await mod.verifyMandate(m, "0xdead", { amount: 0.01, scope: "citation" })).ok).toBe(false);
  });

  it("tracks cumulative clearance so a mandate can't be over-drawn", async () => {
    const m = freshMandate({ nonce: "cumulative", maxAmount: 0.05 });
    const sig = await sign(m);
    expect((await mod.verifyMandate(m, sig, { amount: 0.03, scope: "citation" })).ok).toBe(true);
    // chargeMandate atomically checks the cap AND records — the only path that mutates the cleared ledger
    expect(mod.chargeMandate(m.authorizer, m.nonce, 0.03, m.maxAmount).ok).toBe(true);
    expect(mod.mandateCleared(m.authorizer, m.nonce)).toBeCloseTo(0.03, 6);
    // now only 0.02 remains
    expect((await mod.verifyMandate(m, sig, { amount: 0.02, scope: "citation" })).ok).toBe(true);
    expect((await mod.verifyMandate(m, sig, { amount: 0.03, scope: "citation" })).ok).toBe(false); // 0.06 > 0.05
    // charging beyond the cap is refused atomically
    expect(mod.chargeMandate(m.authorizer, m.nonce, 0.03, m.maxAmount).ok).toBe(false);
  });

  it("scopes the cleared ledger by AUTHORIZER so one signer's nonce can't consume another's cap", async () => {
    const other = privateKeyToAccount(("0x" + "2".repeat(64)) as `0x${string}`);
    const nonce = "shared-nonce";
    // authorizer A clears against the shared nonce
    expect(mod.chargeMandate(account.address, nonce, 0.04, 0.05).ok).toBe(true);
    // authorizer B with the SAME nonce string has an independent, untouched cap
    expect(mod.mandateCleared(other.address, nonce)).toBe(0);
    expect(mod.chargeMandate(other.address, nonce, 0.05, 0.05).ok).toBe(true);
  });
});
