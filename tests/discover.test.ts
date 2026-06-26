import { describe, it, expect } from "vitest";
import { parseFeedItems } from "../lib/discover";

const meta = { pub: "CoinDesk", domain: "coindesk.com", bg: "#0A0A0A" };

describe("parseFeedItems (RSS/Atom → payable articles)", () => {
  it("parses an RSS <item> with an inline <link>url</link>", () => {
    const xml = `<rss><channel>
      <item>
        <title>USDC settles cross-border B2B</title>
        <description>Enterprises use USDC to cut FX and wire costs.</description>
        <link>https://coindesk.com/a1</link>
      </item>
    </channel></rss>`;
    const items = parseFeedItems(xml, meta);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({
      title: "USDC settles cross-border B2B",
      link: "https://coindesk.com/a1",
      pub: "CoinDesk",
      domain: "coindesk.com",
      bg: "#0A0A0A",
    });
    expect(items[0].desc).toContain("USDC");
  });

  it("parses an Atom <entry> using the <link href> form + <summary>", () => {
    const xml = `<feed>
      <entry>
        <title>Stablecoin volume hits a record</title>
        <summary>MiCA clarity drove enterprise adoption.</summary>
        <link href="https://coindesk.com/a2" rel="alternate"/>
      </entry>
    </feed>`;
    const items = parseFeedItems(xml, meta);
    expect(items.length).toBe(1);
    expect(items[0].link).toBe("https://coindesk.com/a2");
    expect(items[0].title).toBe("Stablecoin volume hits a record");
  });

  it("drops items with no link, a non-http link, or a missing description", () => {
    const xml = `<rss>
      <item><title>No link</title><description>has desc</description></item>
      <item><title>Relative</title><description>has desc</description><link>/relative/path</link></item>
      <item><title>No description</title><link>https://coindesk.com/ok</link></item>
    </rss>`;
    expect(parseFeedItems(xml, meta).length).toBe(0);
  });

  it("respects the max cap", () => {
    const one = `<item><title>T</title><description>a real description</description><link>https://coindesk.com/x</link></item>`;
    const xml = `<rss>${one.repeat(10)}</rss>`;
    expect(parseFeedItems(xml, meta, 3).length).toBe(3);
  });

  it("truncates an overlong title to 90 chars", () => {
    const xml = `<rss><item><title>${"A".repeat(200)}</title><description>a description</description><link>https://coindesk.com/y</link></item></rss>`;
    expect(parseFeedItems(xml, meta)[0].title.length).toBe(90);
  });
});
