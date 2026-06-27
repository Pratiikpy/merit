import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hashKey,
  createApiKey,
  verifyKey,
  keyFromRequest,
  remainingBudget,
  chargePrincipal,
  authGate,
  authRequired,
  listPrincipals,
  _resetAuthCache,
} from "../lib/auth";

const TMP = path.join(os.tmpdir(), "merit-auth-test-" + process.pid);
const mkReq = (headers: Record<string, string>) => new Request("http://x/api/run", { method: "POST", headers });

describe("lib/auth (per-principal API keys + fail-closed firewall)", () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    process.env.MERIT_DATA_DIR = TMP;
    delete process.env.MERIT_REQUIRE_AUTH;
    _resetAuthCache();
  });
  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    delete process.env.MERIT_DATA_DIR;
    delete process.env.MERIT_REQUIRE_AUTH;
  });

  it("authRequired: OFF in the STUB demo, ON by default for a real-money (STUB=0) deploy, env-overridable", () => {
    const save = { stub: process.env.STUB, buyer: process.env.BUYER_PRIVATE_KEY };
    // STUB demo (no buyer key) → auth off, keyless demo keeps working
    delete process.env.MERIT_REQUIRE_AUTH;
    delete process.env.STUB;
    delete process.env.BUYER_PRIVATE_KEY;
    expect(authRequired()).toBe(false);
    // real-money deploy (a funded buyer key, not STUB) → auth ON by default (fail-closed)
    process.env.BUYER_PRIVATE_KEY = "0x" + "1".repeat(64);
    expect(authRequired()).toBe(true);
    // explicit env override wins both ways
    process.env.MERIT_REQUIRE_AUTH = "0";
    expect(authRequired()).toBe(false);
    process.env.MERIT_REQUIRE_AUTH = "1";
    delete process.env.BUYER_PRIVATE_KEY;
    expect(authRequired()).toBe(true);
    // restore
    delete process.env.MERIT_REQUIRE_AUTH;
    if (save.stub === undefined) delete process.env.STUB; else process.env.STUB = save.stub;
    if (save.buyer === undefined) delete process.env.BUYER_PRIVATE_KEY; else process.env.BUYER_PRIVATE_KEY = save.buyer;
  });

  it("hashes keys deterministically and never stores plaintext", () => {
    expect(hashKey("abc")).toBe(hashKey("abc"));
    expect(hashKey("abc")).not.toBe("abc");
    const { key, principal } = createApiKey("agent-1", 1.5);
    expect(key).toMatch(/^merit_sk_/);
    expect(principal.keyHash).toBe(hashKey(key));
    expect(JSON.stringify(listPrincipals())).not.toContain(key); // plaintext never surfaced
  });

  it("verifies a valid key and rejects an unknown one", () => {
    const { key, principal } = createApiKey("a", 0);
    expect(verifyKey(key)?.id).toBe(principal.id);
    expect(verifyKey("merit_sk_nope")).toBeNull();
    expect(verifyKey("")).toBeNull();
  });

  it("budget math: 0 cap = unlimited; a cap tracks spend across charges", () => {
    const unlimited = createApiKey("u", 0).principal;
    expect(remainingBudget(unlimited)).toBe(Infinity);
    const { key, principal } = createApiKey("a", 1.0);
    expect(remainingBudget(principal)).toBe(1.0);
    chargePrincipal(principal.id, 0.4);
    const p2 = verifyKey(key)!;
    expect(p2.spent).toBeCloseTo(0.4, 6);
    expect(remainingBudget(p2)).toBeCloseTo(0.6, 6);
  });

  it("keyFromRequest reads Bearer and X-Merit-Key", () => {
    expect(keyFromRequest(mkReq({ Authorization: "Bearer mykey" }))).toBe("mykey");
    expect(keyFromRequest(mkReq({ "X-Merit-Key": "altkey" }))).toBe("altkey");
    expect(keyFromRequest(mkReq({}))).toBe("");
  });

  it("authGate: open by default (anonymous allowed), but a provided-invalid key is always rejected", () => {
    expect(authGate(mkReq({})).ok).toBe(true);
    const bad = authGate(mkReq({ Authorization: "Bearer merit_sk_bad" }));
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(401);
  });

  it("authGate: fail-closed when MERIT_REQUIRE_AUTH=1 — no key rejected, valid key passes with principal", () => {
    process.env.MERIT_REQUIRE_AUTH = "1";
    expect(authGate(mkReq({})).status).toBe(401);
    const { key } = createApiKey("walled", 0);
    const ok = authGate(mkReq({ Authorization: "Bearer " + key }));
    expect(ok.ok).toBe(true);
    expect(ok.principal?.name).toBe("walled");
    delete process.env.MERIT_REQUIRE_AUTH;
  });
});
