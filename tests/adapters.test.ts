import { describe, it, expect } from "vitest";
import { getAdapter, adaptersPass } from "../lib/adapters";
import type { Source } from "../lib/registry";

const src = (over: Partial<Source> = {}): Source => ({
  id: "s", name: "S", handle: "", kind: "API", initials: "S", avatarBg: "#000",
  merit: 50, price: 0.01, wallet: "0x0000000000000000000000000000000000000001",
  content: "", verified: true, balance: 0, ...over,
});

describe("verification adapters (#10)", () => {
  it("numeric: catches a contradicted figure, passes when figures trace", () => {
    expect(getAdapter("numeric")!("claims $40T", "the source says $4.1T", src()).ok).toBe(false);
    expect(getAdapter("numeric")!("claims $4T", "the source says $4.1T", src()).ok).toBe(true);
  });
  it("schema: ok for valid JSON, fails otherwise", () => {
    expect(getAdapter("schema")!("c", '{"a":1}', src()).ok).toBe(true);
    expect(getAdapter("schema")!("c", "not json", src()).ok).toBe(false);
  });
  it("freshness: requires a >=2025 timestamp", () => {
    expect(getAdapter("freshness")!("c", "data from 2026", src()).ok).toBe(true);
    expect(getAdapter("freshness")!("c", "data from 2019", src()).ok).toBe(false);
    expect(getAdapter("freshness")!("c", "no year here", src()).ok).toBe(false);
  });
  it("nonempty: requires substantive content", () => {
    expect(getAdapter("nonempty")!("c", "x".repeat(40), src()).ok).toBe(true);
    expect(getAdapter("nonempty")!("c", "tiny", src()).ok).toBe(false);
  });
  it("adaptersPass: none = ok; all-pass = ok; one fail = not ok, surfacing the reason", () => {
    expect(adaptersPass(undefined, "c", "{}", src()).ok).toBe(true);
    expect(adaptersPass(["schema", "nonempty"], "c", '{"long":"enough to be substantive content for the nonempty adapter"}', src()).ok).toBe(true);
    const r = adaptersPass(["schema"], "c", "not json", src());
    expect(r.ok).toBe(false);
    expect(r.failed!.id).toBe("schema");
  });
  it("an unknown adapter id is skipped (treated as ok)", () => {
    expect(adaptersPass(["bogus"], "c", "x", src()).ok).toBe(true);
  });
});
