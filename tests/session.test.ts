import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let dir: string;
let sess: typeof import("../lib/session");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-session-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
  sess = await import("../lib/session");
});
afterAll(() => vi.useRealTimers());

describe("verify-bound session keys (Wave D #14)", () => {
  it("mints a scoped key and resolves it", () => {
    const s = sess.issueSession("prin_a", { cap: 0.05, ttlMs: 3_600_000, label: "agent-1" });
    expect(s.sessionKey.startsWith("merit_sess_")).toBe(true);
    expect(sess.isSessionKey(s.sessionKey)).toBe(true);
    expect(sess.isSessionKey("merit_sk_whatever")).toBe(false);
    const r = sess.resolveSession(s.sessionKey);
    expect(r?.parentId).toBe("prin_a");
    expect(sess.resolveSession("merit_sess_bogus")).toBe(null);
    expect(sess.resolveSession("not-a-session")).toBe(null);
  });

  it("enforces the cap and refunds a rolled-back charge", () => {
    const s = sess.issueSession("prin_b", { cap: 0.05, ttlMs: 3_600_000 });
    expect(sess.chargeSession(s.id, 0.03).ok).toBe(true);
    expect(sess.chargeSession(s.id, 0.03).ok).toBe(false); // 0.06 > 0.05 cap
    expect(sess.chargeSession(s.id, 0.02).ok).toBe(true); // exactly at the cap
    expect(sess.chargeSession(s.id, 0.001).ok).toBe(false); // empty
    sess.refundSession(s.id, 0.02); // the balance debit failed → give it back
    expect(sess.chargeSession(s.id, 0.02).ok).toBe(true);
  });

  it("revokes immediately and is scoped to the parent", () => {
    const s = sess.issueSession("prin_c", { cap: 0.01, ttlMs: 3_600_000 });
    expect(sess.revokeSession(s.id, "prin_other")).toBe(false); // not your session
    expect(sess.revokeSession(s.id, "prin_c")).toBe(true);
    expect(sess.resolveSession(s.sessionKey)).toBe(null); // revoked → unusable
    expect(sess.chargeSession(s.id, 0.001).ok).toBe(false);
  });

  it("expires after its TTL", () => {
    const s = sess.issueSession("prin_d", { cap: 0.01, ttlMs: 60_000 });
    expect(sess.resolveSession(s.sessionKey)?.id).toBe(s.id);
    vi.setSystemTime(new Date("2026-04-01T00:02:00Z")); // +120s > 60s TTL
    expect(sess.resolveSession(s.sessionKey)).toBe(null);
    expect(sess.chargeSession(s.id, 0.001).ok).toBe(false); // expired
  });
});
