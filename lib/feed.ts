/**
 * One-click creator onboarding from an RSS/Atom feed — the distribution wedge.
 *
 * Paste a feed URL → Merit reads the publisher's recent work, turns it into a citable + payable creator, and
 * (if the feed carries a `merit-verify:0x…` marker) sets the payout to the owner's own wallet. No account, no
 * key handed to Merit — the wallet is receive-only. This is how a real external publisher joins in one step.
 *
 * Dependency-free: a tolerant regex parser (RSS <item> and Atom <entry>), so the repo stays fork-and-run.
 */

export interface FeedEntry {
  title: string;
  summary: string;
}
export interface ParsedFeed {
  title: string;
  link: string;
  entries: FeedEntry[];
  verifyWallet?: `0x${string}`; // owner-proven payout wallet, if the feed carries a merit-verify marker
}

const MAX_BYTES = 512 * 1024; // never read an unbounded feed

/** Strip CDATA + tags, decode the common XML/HTML entities, collapse whitespace. */
function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'").replace(/&#x2F;/gi, "/").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

/** Parse RSS or Atom XML into a feed title, link, recent entries, and any owner-verification wallet. */
export function parseFeed(xml: string, sourceUrl: string): ParsedFeed {
  // Everything before the first item/entry is the channel/feed header (its title + site link).
  const head = xml.split(/<item[\s>]|<entry[\s>]/i)[0] || xml;
  let host = sourceUrl;
  try { host = new URL(sourceUrl).hostname; } catch { /* keep raw */ }
  const title = tag(head, "title") || host;
  const link =
    head.match(/<link[^>]*\bhref=["']([^"']+)["']/i)?.[1] || // Atom <link href="">
    tag(head, "link") || // RSS <link>text</link>
    sourceUrl;

  const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]).slice(0, 8);
  const entries = blocks
    .map((b) => ({ title: tag(b, "title"), summary: tag(b, "description") || tag(b, "summary") || tag(b, "content") }))
    .filter((e) => e.title || e.summary);

  // Ownership proof: the publisher drops `merit-verify:0x…` anywhere in the feed (a tagline, an item) to bind
  // payouts to their own wallet — permissionless, but only they can edit their feed. Never the zero address.
  const vm = xml.match(/merit-verify:\s*(0x[0-9a-fA-F]{40})\b/);
  const verifyWallet = vm && !/^0x0+$/i.test(vm[1]) ? (vm[1] as `0x${string}`) : undefined;

  return { title: title.slice(0, 80), link: link.slice(0, 200), entries, verifyWallet };
}

/** Fetch a feed URL (http/https only, bounded) and parse it. Throws a short, user-facing message on failure. */
export async function fetchFeed(url: string): Promise<ParsedFeed> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("not a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) feeds are supported");

  const res = await fetch(u, {
    headers: { "user-agent": "merit-onboarding/1", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new Error("could not reach the feed"); });
  if (!res.ok) throw new Error(`feed returned ${res.status}`);

  // Bounded read so a giant/streamed response can't exhaust memory.
  const buf = await res.arrayBuffer();
  const xml = new TextDecoder().decode(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf);
  if (!/<rss|<feed|<channel|<item|<entry/i.test(xml)) throw new Error("that URL is not an RSS or Atom feed");

  const feed = parseFeed(xml, url);
  if (!feed.entries.length) throw new Error("the feed has no readable entries");
  return feed;
}

/** Combine a feed's recent entries into the citable source text Merit reads + verifies against (capped). */
export function feedContent(feed: ParsedFeed): string {
  return feed.entries
    .map((e) => [e.title, e.summary].filter(Boolean).join(" — "))
    .join("\n\n")
    .slice(0, 2000);
}
