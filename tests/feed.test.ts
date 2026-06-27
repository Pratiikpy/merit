import { describe, it, expect } from "vitest";
import { parseFeed, feedContent } from "../lib/feed";

describe("feed parser (one-click creator onboarding)", () => {
  const rss = `<rss><channel>
    <title>Vitalik Buterin blog</title>
    <link>https://vitalik.eth.limo</link>
    <description>notes on Ethereum — merit-verify:0x1111111111111111111111111111111111111111</description>
    <item><title>On nanopayments</title><description><![CDATA[Sub-cent settlement crossed $4.1T in 2026.]]></description></item>
    <item><title>Proof of citation</title><description>Verification gates payment.</description></item>
  </channel></rss>`;

  it("extracts title, link, and entries from RSS", () => {
    const f = parseFeed(rss, "https://vitalik.eth.limo/feed.xml");
    expect(f.title).toBe("Vitalik Buterin blog");
    expect(f.link).toBe("https://vitalik.eth.limo");
    expect(f.entries).toHaveLength(2);
    expect(f.entries[0].title).toBe("On nanopayments");
  });

  it("reads the merit-verify ownership wallet from the feed", () => {
    const f = parseFeed(rss, "https://x");
    expect(f.verifyWallet).toBe("0x1111111111111111111111111111111111111111");
  });

  it("leaves verifyWallet undefined when there is no marker (Merit mints a receive-only wallet)", () => {
    const f = parseFeed(rss.replace(/ — merit-verify:0x1+/, ""), "https://x");
    expect(f.verifyWallet).toBeUndefined();
  });

  it("ignores the zero address as an ownership wallet", () => {
    const f = parseFeed(`<rss><channel><title>z</title><item><title>a</title><description>b merit-verify:0x0000000000000000000000000000000000000000</description></item></channel></rss>`, "https://x");
    expect(f.verifyWallet).toBeUndefined();
  });

  it("parses Atom <entry><summary> too", () => {
    const atom = `<feed><title>Atom Blog</title><link href="https://atom.example"/><entry><title>Post A</title><summary>first</summary></entry></feed>`;
    const f = parseFeed(atom, "https://atom.example/atom.xml");
    expect(f.title).toBe("Atom Blog");
    expect(f.link).toBe("https://atom.example");
    expect(f.entries[0].summary).toBe("first");
  });

  it("combines entries into bounded citable content", () => {
    const f = parseFeed(rss, "https://x");
    const c = feedContent(f);
    expect(c).toContain("On nanopayments");
    expect(c).toContain("$4.1T");
    expect(c.length).toBeLessThanOrEqual(2000);
  });
});
