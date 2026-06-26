import { describe, it, expect } from "vitest";
import { getProvider, resolveSourceContent } from "../lib/providers";
import type { Source } from "../lib/registry";

const src = (over: Partial<Source> = {}): Source => ({
  id: "s", name: "S", handle: "", kind: "API", initials: "S", avatarBg: "#000",
  merit: 50, price: 0.01, wallet: "0x0000000000000000000000000000000000000001",
  content: "static content", verified: true, balance: 0, ...over,
});

describe("provider adapters (#9)", () => {
  it("the fixture provider is always available and returns deterministic live content", async () => {
    const p = getProvider("fixture")!;
    expect(p.available()).toBe(true);
    const c = await p.fetch("What drives stablecoin adoption?", src());
    expect(c).toContain("$4.1T");
  });
  it("firecrawl is unavailable without a key (graceful skip)", () => {
    delete process.env.FIRECRAWL_API_KEY;
    expect(getProvider("firecrawl")!.available()).toBe(false);
    expect(getProvider("unknown")).toBeUndefined();
  });
  it("resolveSourceContent: static for a plain source, LIVE for a provider-backed one", async () => {
    expect(await resolveSourceContent(src(), "q")).toBe("static content");
    expect(await resolveSourceContent(src({ provider: "fixture" }), "stablecoins")).toContain("$4.1T");
  });
  it("resolveSourceContent: null when the provider is named but unavailable (caller keeps static content)", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    expect(await resolveSourceContent(src({ provider: "firecrawl" }), "q")).toBeNull();
    expect(await resolveSourceContent(src({ provider: "unknown" }), "q")).toBeNull();
  });
});
