import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Verdict, VerifyOutcome } from "../lib/verify/engine";

let dir: string;
let vc: typeof import("../lib/vcache");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-vcache-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE; // local-file store
  process.env.STUB = "1";
  process.env.MERIT_VCACHE_TTL_MS = "100000"; // 100s
  process.env.MERIT_VCACHE_COST_USD = "0.002";
  vc = await import("../lib/vcache");
});

afterEach(() => {
  vi.useRealTimers();
});

function mkVerdict(claim: string): Verdict {
  return {
    schema: "merit.cvo/v2",
    engineVersion: "merit-verify/0.1.0",
    claim,
    sourceHash: "0xabc",
    verdict: "SUPPORTED",
    grounded: true,
    score: 0.9,
    methods: ["injection-guard", "numeric", "nli", "llm-judge"],
    reason: "supported",
    modelTag: "test",
    verifiedAt: new Date(0).toISOString(),
    signer: "0x1111111111111111111111111111111111111111",
    signature: "0xsig",
  };
}
const ok = (claim: string): VerifyOutcome => ({ verdict: mkVerdict(claim) });

describe("verified-citation cache", () => {
  it("keys deterministically, separates fields, and re-keys on any change", () => {
    const k = vc.cacheKey("claim one", "source one");
    expect(k).toBe(vc.cacheKey("claim one", "source one")); // deterministic
    expect(k).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(vc.cacheKey("a", "bc")).not.toBe(vc.cacheKey("ab", "c")); // boundary must not shift
    // boundary-collision cases a naive space/char separator WOULD collide (the Wave-A review finding) —
    // length-prefixed framing keeps them distinct so no poisoned verdict is served for an unsubmitted pair
    expect(vc.cacheKey("a b", "c")).not.toBe(vc.cacheKey("a", "b c"));
    expect(vc.cacheKey("Acme raised $5M", "Acme is a company.")).not.toBe(vc.cacheKey("Acme", "raised $5M Acme is a company."));
    expect(vc.cacheKey("claim one", "source two")).not.toBe(k); // changed source → different key
  });

  it("misses then hits, and skips the recompute on a hit", async () => {
    let runs = 0;
    const run = () => { runs++; return Promise.resolve(ok("A1")); };
    const first = await vc.verifyWithCache("A1", "src-a", run);
    expect(first.cached).toBe(false);
    expect(runs).toBe(1);
    const second = await vc.verifyWithCache("A1", "src-a", run);
    expect(second.cached).toBe(true);
    expect(runs).toBe(1); // recompute skipped
    if (!("error" in second.outcome)) expect(second.outcome.verdict.claim).toBe("A1");
  });

  it("re-verifies when the source changes (never serves a stale verdict)", async () => {
    let runs = 0;
    const run = () => { runs++; return Promise.resolve(ok("A2")); };
    await vc.verifyWithCache("A2", "src-original", run);
    const changed = await vc.verifyWithCache("A2", "src-MUTATED", run);
    expect(changed.cached).toBe(false); // different source → miss → recompute
    expect(runs).toBe(2);
  });

  it("never caches an error outcome", async () => {
    let runs = 0;
    const run = () => { runs++; return Promise.resolve({ error: "keyless", status: 503 } as VerifyOutcome); };
    const a = await vc.verifyWithCache("A3", "src-a3", run);
    const b = await vc.verifyWithCache("A3", "src-a3", run);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false); // a 503 must be retryable, never served from cache
    expect(runs).toBe(2);
  });

  it("bypasses the cache when cache:false", async () => {
    let runs = 0;
    const run = () => { runs++; return Promise.resolve(ok("A4")); };
    await vc.verifyWithCache("A4", "src-a4", run, { cache: false });
    const again = await vc.verifyWithCache("A4", "src-a4", run, { cache: false });
    expect(again.cached).toBe(false);
    expect(runs).toBe(2);
  });

  it("re-verifies after the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let runs = 0;
    const run = () => { runs++; return Promise.resolve(ok("A5")); };
    await vc.verifyWithCache("A5", "src-a5", run); // stored at T0
    const within = await vc.verifyWithCache("A5", "src-a5", run);
    expect(within.cached).toBe(true); // still fresh
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z")); // +120s > 100s TTL
    const expired = await vc.verifyWithCache("A5", "src-a5", run);
    expect(expired.cached).toBe(false); // TTL elapsed → recompute
    expect(runs).toBe(2);
  });

  it("reports true avoided-count + an estimated saving", async () => {
    const before = vc.cacheStats().reverificationsAvoided;
    let runs = 0;
    const run = () => { runs++; return Promise.resolve(ok("A6")); };
    await vc.verifyWithCache("A6", "src-a6", run); // miss
    await vc.verifyWithCache("A6", "src-a6", run); // hit (+1)
    await vc.verifyWithCache("A6", "src-a6", run); // hit (+1)
    const s = vc.cacheStats();
    expect(s.reverificationsAvoided).toBe(before + 2);
    expect(s.entries).toBeGreaterThan(0);
    expect(s.costPerVerifyUsd).toBeCloseTo(0.002, 6);
    expect(s.estSavedUsd).toBeCloseTo(s.reverificationsAvoided * 0.002, 6);
  });
});
