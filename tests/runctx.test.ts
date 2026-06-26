import { describe, it, expect, vi } from "vitest";
import { createCtx, getCtx, patchCtx, deleteCtx } from "../lib/runctx";

describe("run context (the shared lead ↔ specialist store)", () => {
  it("creates with empty artifacts + the given init, and reads back the same object", () => {
    const ctx = createCtx("r1", { question: "q1", budget: 0.5, discover: false });
    expect(ctx.sources).toEqual([]);
    expect(ctx.answer).toBe("");
    expect(ctx.cite).toEqual({});
    expect(ctx.question).toBe("q1");
    expect(ctx.budget).toBe(0.5);
    expect(getCtx("r1")).toBe(ctx);
  });

  it("patchCtx merges fields without clobbering the rest", () => {
    createCtx("r2", { question: "q2", budget: 1, discover: true });
    patchCtx("r2", { answer: "hello" });
    patchCtx("r2", { cite: { s1: { cited: true, supported: true, score: 0.82, reason: "supported", count: 2 } } });
    const ctx = getCtx("r2")!;
    expect(ctx.answer).toBe("hello"); // preserved across the second patch
    expect(ctx.cite.s1.count).toBe(2);
    expect(ctx.discover).toBe(true);
  });

  it("patchCtx on an unknown run is a no-op (never throws)", () => {
    expect(() => patchCtx("ghost", { answer: "x" })).not.toThrow();
    expect(getCtx("ghost")).toBeUndefined();
  });

  it("deleteCtx frees the context (the per-run cleanup)", () => {
    createCtx("r3", { question: "q3", budget: 1, discover: false });
    expect(getCtx("r3")).toBeDefined();
    deleteCtx("r3");
    expect(getCtx("r3")).toBeUndefined();
  });

  it("concurrent runs are fully isolated by runId", () => {
    createCtx("rA", { question: "A", budget: 1, discover: false });
    createCtx("rB", { question: "B", budget: 2, discover: true });
    patchCtx("rA", { answer: "answerA" });
    expect(getCtx("rA")?.answer).toBe("answerA");
    expect(getCtx("rB")?.answer).toBe(""); // B untouched by A's patch
    expect(getCtx("rA")?.question).toBe("A");
    expect(getCtx("rB")?.budget).toBe(2);
  });

  it("expires a context after its TTL (defense-in-depth against a leaked runId)", () => {
    vi.useFakeTimers();
    try {
      createCtx("ttl1", { question: "q", budget: 1, discover: false });
      expect(getCtx("ttl1")).toBeDefined();
      vi.advanceTimersByTime(9 * 60 * 1000); // still inside the 10-min TTL
      expect(getCtx("ttl1")).toBeDefined();
      vi.advanceTimersByTime(2 * 60 * 1000); // now past the TTL
      expect(getCtx("ttl1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds growth: oldest contexts are evicted past the 200 cap", () => {
    for (let i = 0; i < 250; i++) createCtx(`e${i}`, { question: "q", budget: 1, discover: false });
    expect(getCtx("e249")).toBeDefined(); // newest kept
    expect(getCtx("e0")).toBeUndefined(); // oldest evicted
    expect(getCtx("e10")).toBeUndefined(); // early ones evicted
  });
});
