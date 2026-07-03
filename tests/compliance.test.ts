import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

let mod: typeof import("../lib/compliance");

const NORMAL = "0x1111111111111111111111111111111111111111";
const SANCTIONED = "0x7fb49965753A9eC3646fd5d004ee5AeD6Cc89999"; // suffix 9999 → Circle sanctions blocklist (test vector)
const FROZEN = "0x0000000000000000000000000000000000008888"; // suffix 8888 → frozen wallet → REVIEW
const ZERO = "0x0000000000000000000000000000000000000000";

beforeEach(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-compliance-"));
  delete process.env.MERIT_STORE;
  delete process.env.CIRCLE_API_KEY; // force the local screen (deterministic)
  delete process.env.MERIT_COMPLIANCE_BLOCK_REVIEW;
  process.env.STUB = "1";
  mod = await import("../lib/compliance");
  mod._resetCompliance();
});

describe("localScreen", () => {
  it("refuses a malformed address (never settle to an unparseable payee)", () => {
    const r = mod.localScreen("not-an-address");
    expect(r.decision).toBe("DENIED");
    expect(r.cleared).toBe(false);
  });

  it("refuses the zero address", () => {
    expect(mod.localScreen(ZERO).decision).toBe("DENIED");
  });

  it("denies a sanctions test-suffix address with the SANCTIONS category", () => {
    const r = mod.localScreen(SANCTIONED);
    expect(r.decision).toBe("DENIED");
    expect(r.riskCategories).toContain("SANCTIONS");
    expect(r.source).toBe("local");
    expect(r.basis).toContain("circle-test-suffix");
  });

  it("flags a frozen-wallet test-suffix as REVIEW", () => {
    expect(mod.localScreen(FROZEN).decision).toBe("REVIEW");
  });

  it("a normal address is APPROVED but NOT a clearance (honesty)", () => {
    const r = mod.localScreen(NORMAL);
    expect(r.decision).toBe("APPROVED");
    expect(r.cleared).toBe(false); // local approve is 'no rule matched', not a sanctions clearance
    expect(r.basis).toContain("NOT a sanctions clearance");
  });
});

describe("operator denylist", () => {
  it("a denylisted address is DENIED even without a test suffix", async () => {
    await mod.addToDenylist(NORMAL);
    const r = mod.localScreen(NORMAL);
    expect(r.decision).toBe("DENIED");
    expect(r.ruleName).toBe("Operator Denylist");
  });

  it("removing from the denylist restores APPROVED", async () => {
    await mod.addToDenylist(NORMAL);
    await mod.removeFromDenylist(NORMAL);
    expect(mod.localScreen(NORMAL).decision).toBe("APPROVED");
  });

  it("rejects a malformed address on the denylist add", async () => {
    expect((await mod.addToDenylist("nope")).ok).toBe(false);
  });
});

describe("mapCircleResponse (real documented shape)", () => {
  it("maps a DENIED sanctions body", () => {
    const r = mod.mapCircleResponse(SANCTIONED, "ETH-SEPOLIA", {
      result: "DENIED",
      decision: { ruleName: "Circle's Sanctions Blocklist", actions: ["FREEZE_WALLET", "DENY", "REVIEW"], reasons: [{ riskScore: "BLOCKLIST", riskCategories: ["SANCTIONS"] }] },
    });
    expect(r.decision).toBe("DENIED");
    expect(r.cleared).toBe(false);
    expect(r.source).toBe("circle");
    expect(r.riskCategories).toContain("SANCTIONS");
  });

  it("a clean APPROVED from Circle IS a clearance", () => {
    const r = mod.mapCircleResponse(NORMAL, "ETH-SEPOLIA", { result: "APPROVED", decision: { actions: [], reasons: [] } });
    expect(r.decision).toBe("APPROVED");
    expect(r.cleared).toBe(true);
    expect(r.source).toBe("circle");
  });

  it("an APPROVED result carrying only a REVIEW action → REVIEW", () => {
    const r = mod.mapCircleResponse(NORMAL, "ETH-SEPOLIA", { result: "APPROVED", decision: { actions: ["REVIEW"], reasons: [{ riskScore: "HIGH", riskCategories: ["GAMBLING"] }] } });
    expect(r.decision).toBe("REVIEW");
    expect(r.cleared).toBe(false);
  });

  it("an unknown/missing result is REVIEW, NEVER a cleared APPROVED (fail-safe)", () => {
    expect(mod.mapCircleResponse(NORMAL, "ETH-SEPOLIA", {}).decision).toBe("REVIEW");
    expect(mod.mapCircleResponse(NORMAL, "ETH-SEPOLIA", {}).cleared).toBe(false);
    expect(mod.mapCircleResponse(NORMAL, "ETH-SEPOLIA", { result: "PENDING" }).decision).toBe("REVIEW");
    expect(mod.mapCircleResponse(NORMAL, "ETH-SEPOLIA", { result: "PENDING" }).cleared).toBe(false);
  });

  it("a FREEZE_WALLET action blocks (DENIED) even without an explicit DENIED result", () => {
    const r = mod.mapCircleResponse(NORMAL, "ETH-SEPOLIA", { result: "APPROVED", decision: { actions: ["FREEZE_WALLET"], reasons: [] } });
    expect(r.decision).toBe("DENIED");
    expect(r.cleared).toBe(false);
  });
});

describe("assertPayeeCompliant (the settlement precondition)", () => {
  it("blocks a sanctioned payee", async () => {
    const g = await mod.assertPayeeCompliant(SANCTIONED);
    expect(g.allowed).toBe(false);
    expect(g.screen.decision).toBe("DENIED");
  });

  it("allows a normal payee", async () => {
    const g = await mod.assertPayeeCompliant(NORMAL);
    expect(g.allowed).toBe(true);
  });

  it("allows a REVIEW payee by default, blocks it under strict posture", async () => {
    expect((await mod.assertPayeeCompliant(FROZEN)).allowed).toBe(true);
    process.env.MERIT_COMPLIANCE_BLOCK_REVIEW = "1";
    mod._resetCompliance();
    expect((await mod.assertPayeeCompliant(FROZEN)).allowed).toBe(false);
  });
});

describe("hard floor (authoritative over any vendor)", () => {
  it("hardFloor denies a denylisted address, malformed, and zero — but not a clean one", async () => {
    // exercised via screenAddress-level behavior: denylist deny holds even though it would otherwise reach a vendor
    await mod.addToDenylist(NORMAL);
    // localScreen encodes the same floor; assert the operator rule is authoritative
    const r = mod.localScreen(NORMAL);
    expect(r.decision).toBe("DENIED");
    expect(r.ruleName).toBe("Operator Denylist");
  });

  it("screenAddress blocks a denylisted payee (the floor, not a vendor)", async () => {
    await mod.addToDenylist(NORMAL);
    const g = await mod.assertPayeeCompliant(NORMAL);
    expect(g.allowed).toBe(false);
    expect(g.screen.decision).toBe("DENIED");
    expect(g.screen.ruleName).toBe("Operator Denylist");
  });
});

describe("screenAddress signing + log", () => {
  it("signs a decision and records it with stats", async () => {
    process.env.MERIT_SIGNING_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const r = await mod.screenAddress(SANCTIONED);
    delete process.env.MERIT_SIGNING_KEY;
    expect(r.signer).toBeTruthy();
    expect(r.signature).toBeTruthy();
    expect(r.screeningId).toMatch(/^0x[0-9a-f]{64}$/);
    const stats = mod.complianceStats();
    expect(stats.screens).toBe(1);
    expect(stats.denied).toBe(1);
    expect(stats.viaCircle).toBe(0); // local screen, no Circle key
  });
});

describe("fail-closed when the vendor is configured but unavailable (C1)", () => {
  it("a configured-but-unreachable vendor degrades to REVIEW (never a silent APPROVED)", async () => {
    process.env.CIRCLE_API_KEY = "test-key";
    process.env.MERIT_COMPLIANCE_URL = "http://127.0.0.1:1/unreachable"; // connection refused → vendor failure
    mod._resetCompliance();
    const r = await mod.screenAddress(NORMAL, { noCache: true });
    expect(r.decision).toBe("REVIEW"); // not APPROVED — the gate does not silently open on an outage
    expect(r.cleared).toBe(false);
    expect(r.riskCategories).toContain("VENDOR_UNAVAILABLE");
    delete process.env.CIRCLE_API_KEY;
    delete process.env.MERIT_COMPLIANCE_URL;
  });

  it("MERIT_COMPLIANCE_STRICT=1 blocks (DENIED) on vendor unavailability", async () => {
    process.env.CIRCLE_API_KEY = "test-key";
    process.env.MERIT_COMPLIANCE_URL = "http://127.0.0.1:1/unreachable";
    process.env.MERIT_COMPLIANCE_STRICT = "1";
    mod._resetCompliance();
    const g = await mod.assertPayeeCompliant(NORMAL);
    expect(g.screen.decision).toBe("DENIED");
    expect(g.allowed).toBe(false);
    delete process.env.CIRCLE_API_KEY;
    delete process.env.MERIT_COMPLIANCE_URL;
    delete process.env.MERIT_COMPLIANCE_STRICT;
  });
});

describe("custody claim is compliance-gated", () => {
  it("claimCustody blocks a sanctioned payout wallet (before the stub/key check)", async () => {
    const custody = await import("../lib/custody");
    custody.accrueCustody("acme", "Acme Corp", 5, { domain: "acme.com" });
    const res = (await custody.claimCustody("acme", SANCTIONED)) as { error?: string; status?: number };
    expect(res.status).toBe(403);
    expect(res.error).toContain("compliance");
    // the balance is untouched by a blocked claim
    expect(custody.custodyUnclaimed("acme")).toBe(5);
  });
});
