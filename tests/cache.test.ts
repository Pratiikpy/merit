import { describe, it, expect } from "vitest";
import { TTLCache } from "../lib/cache";

// The verdict cache bounds both memory (LRU eviction past `max`) and staleness (TTL). Verified
// deterministically by passing an explicit `now`.
describe("TTLCache", () => {
  it("returns a value before its TTL and undefined once stale", () => {
    const c = new TTLCache<number>(10, 1000);
    c.set("a", 1, 0);
    expect(c.get("a", 500)).toBe(1); // within the TTL window
    expect(c.get("a", 1000)).toBeUndefined(); // exactly at expiry → stale
    expect(c.get("a", 2000)).toBeUndefined();
    expect(c.size).toBe(0); // a stale read evicts the entry
  });

  it("evicts the least-recently-used entry once over max size", () => {
    const c = new TTLCache<number>(2, 10_000);
    c.set("a", 1, 0);
    c.set("b", 2, 0);
    c.get("a", 1); // touch 'a' → 'b' becomes the LRU
    c.set("c", 3, 1); // over the cap of 2 → evict the LRU ('b')
    expect(c.get("a", 2)).toBe(1);
    expect(c.get("b", 2)).toBeUndefined(); // evicted
    expect(c.get("c", 2)).toBe(3);
    expect(c.size).toBe(2);
  });

  it("overwrites an existing key without growing, and clear() empties it", () => {
    const c = new TTLCache<string>(5, 1000);
    c.set("k", "v1", 0);
    c.set("k", "v2", 0);
    expect(c.get("k", 0)).toBe("v2");
    expect(c.size).toBe(1);
    c.clear();
    expect(c.get("k", 0)).toBeUndefined();
    expect(c.size).toBe(0);
  });
});
