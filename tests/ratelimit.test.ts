import { describe, it, expect, beforeEach } from "vitest";
import { checkRunLimit, checkChallengeLimit, tryAcquireRunSlot, releaseRunSlot, _resetRateLimit } from "../lib/ratelimit";

describe("checkRunLimit (guards the buyer's wallet from run-spam)", () => {
  beforeEach(() => _resetRateLimit());

  it("allows the first run, blocks a rapid same-IP retry with 429", () => {
    expect(checkRunLimit("1.1.1.1", 1000).allowed).toBe(true);
    const d = checkRunLimit("1.1.1.1", 2000); // 1s later, under the 8s cooldown
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(429);
  });

  it("lets the same IP run again once the cooldown elapses", () => {
    checkRunLimit("1.1.1.1", 1000);
    expect(checkRunLimit("1.1.1.1", 1000 + 8001).allowed).toBe(true);
  });

  it("enforces a global cap that IP-spoofing cannot bypass (503)", () => {
    // 15 distinct (spoofed) IPs in the window each pass the per-IP check...
    for (let i = 0; i < 15; i++) expect(checkRunLimit("ip" + i, 1000 + i).allowed).toBe(true);
    // ...but the 16th is blocked globally, regardless of a brand-new IP
    const d = checkRunLimit("fresh-ip", 1100);
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(503);
  });

  it("frees global capacity as the 60s window slides", () => {
    for (let i = 0; i < 15; i++) checkRunLimit("ip" + i, 1000);
    expect(checkRunLimit("later", 1000 + 60_001).allowed).toBe(true);
  });
});

describe("concurrency guard (bound runs settling against the wallet at once)", () => {
  beforeEach(() => _resetRateLimit());

  it("acquires up to the cap, refuses past it, and a release frees a slot", () => {
    for (let i = 0; i < 4; i++) expect(tryAcquireRunSlot()).toBe(true); // up to MAX_CONCURRENT_RUNS
    expect(tryAcquireRunSlot()).toBe(false); // at capacity
    releaseRunSlot();
    expect(tryAcquireRunSlot()).toBe(true); // a freed slot is reusable
  });

  it("releaseRunSlot never underflows below zero", () => {
    releaseRunSlot();
    releaseRunSlot(); // extra releases are harmless (the route's once-flag prevents these anyway)
    for (let i = 0; i < 4; i++) expect(tryAcquireRunSlot()).toBe(true); // still exactly 4 from zero
    expect(tryAcquireRunSlot()).toBe(false);
  });
});

describe("checkChallengeLimit (gates the LLM re-audit endpoint by global volume, no per-IP cascade)", () => {
  beforeEach(() => _resetRateLimit());

  it("allows rapid back-to-back calls — NO per-IP cooldown to cascade-block judge-eval's 16 sequential calls", () => {
    // The regression this guards against: a per-IP cooldown 429s a sequential client once any reply is fast.
    for (let i = 0; i < 16; i++) expect(checkChallengeLimit(1000 + i).allowed).toBe(true);
  });

  it("enforces the global volume cap with 503 past 40 in the window", () => {
    for (let i = 0; i < 40; i++) expect(checkChallengeLimit(1000 + i).allowed).toBe(true);
    const d = checkChallengeLimit(1100);
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(503);
  });

  it("frees capacity as the 60s window slides", () => {
    for (let i = 0; i < 40; i++) checkChallengeLimit(1000);
    expect(checkChallengeLimit(1000 + 60_001).allowed).toBe(true);
  });
});
