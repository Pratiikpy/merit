import { describe, it, expect } from "vitest";
import { getSources } from "../lib/registry";

/**
 * Regression: production hydrates the source registry from the Supabase mirror. When a mirrored row
 * had lost its `content`, patchSeedFields restored `splits` but NOT `content`, so every seed source
 * reached the writer empty. The writer then correctly answered NO_RELEVANT_SOURCES and the entire
 * run refunded — the homepage demo paid creators $0 on its own default question, reproducibly.
 */
describe("seed sources always carry their content", () => {
  it("every seed source has non-empty content the writer can read", () => {
    // Seed sources are the static demo registry. Onboarded creators (c_*) and live-discovered
    // articles (art_*) legitimately may carry no static content, so they are out of scope here.
    const seeded = getSources().filter((s) => !/^(c_|cr_|art_)/.test(s.id));
    expect(seeded.length).toBeGreaterThan(0);
    const empty = seeded.filter((s) => !s.content || !s.content.trim());
    expect(empty.map((s) => s.id)).toEqual([]);
  });

  it("content is substantial enough to ground a citation", () => {
    for (const s of getSources().filter((x) => !/^(c_|cr_|art_)/.test(x.id) && x.content)) {
      expect(s.content.length, `${s.id} content too short to verify against`).toBeGreaterThan(40);
    }
  });
});
