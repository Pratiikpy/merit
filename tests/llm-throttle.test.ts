import { describe, it, expect } from "vitest";
import { llmAcquire, LLM_MAX_CONCURRENT } from "../lib/llm";

// The throttle is what stops verifyCitations' parallel embed+judge burst from 429-ing the provider.
// Verified deterministically (no LLM): cap is honored, overflow QUEUES (not fails), a release frees it.
describe("LLM concurrency throttle", () => {
  it("fills the cap, queues the overflow, and a release frees the waiting call", async () => {
    const held: Array<() => void> = [];
    for (let i = 0; i < LLM_MAX_CONCURRENT; i++) held.push(await llmAcquire()); // saturate the cap

    let overflowAcquired = false;
    const overflow = llmAcquire().then((release) => {
      overflowAcquired = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(overflowAcquired).toBe(false); // over the cap → genuinely queued, NOT acquired (and not rejected)

    held[0](); // free one slot
    const overflowRelease = await overflow;
    expect(overflowAcquired).toBe(true); // the queued call runs the instant a slot opens

    // release everything so the module-level counter returns to zero for the next test
    overflowRelease();
    held.slice(1).forEach((release) => release());
  });

  it("acquires immediately while under the cap (no queueing)", async () => {
    const releases = await Promise.all(Array.from({ length: LLM_MAX_CONCURRENT }, () => llmAcquire()));
    expect(releases).toHaveLength(LLM_MAX_CONCURRENT);
    releases.forEach((release) => release());
  });
});
