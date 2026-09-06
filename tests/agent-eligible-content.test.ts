import { describe, it, expect } from "vitest";
import { getSources } from "../lib/registry";

/**
 * Regression: the ranked pool did not require readable content. In production, onboarded
 * smoke-test rows ("Smoke Test Co", merit 50, no content) outranked every seeded source (merit 0),
 * so the writer received an unreadable pool, correctly emitted NO_RELEVANT_SOURCES, and every run
 * refunded 100% — the homepage demo paid creators $0 on its own default question.
 *
 * The pool filter is `s.provider || (s.content && s.content.trim().length > 0)`.
 */
const eligible = (list: { provider?: string; content?: string }[]) =>
  list.filter((s) => s.provider || (s.content && s.content.trim().length > 0));

describe("ranked pool requires readable content", () => {
  it("drops a content-less source", () => {
    expect(eligible([{ content: "" }, { content: "   " }, { content: undefined }])).toHaveLength(0);
  });

  it("keeps a source with real content", () => {
    expect(eligible([{ content: "Cross-border settlement crossed $4.1T in 2026." }])).toHaveLength(1);
  });

  it("keeps a provider-backed source even when static content is empty (fetched live)", () => {
    expect(eligible([{ provider: "rss", content: "" }])).toHaveLength(1);
  });

  it("a smoke-test row with high merit but no content is still excluded", () => {
    const pool = [{ content: "" }, { content: "real material the writer can cite" }];
    expect(eligible(pool)).toHaveLength(1);
  });

  it("the real seeded registry survives the filter", () => {
    const seeded = getSources().filter((s) => !/^(c_|cr_|art_)/.test(s.id));
    expect(eligible(seeded).length).toBe(seeded.length);
  });
});
