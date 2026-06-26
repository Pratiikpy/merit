/**
 * Live source discovery: instead of the curated seed pool, pull REAL articles
 * from publisher RSS feeds and turn them into payable sources. This is the
 * product's real-world shape — the agent discovers actual publishers and pays
 * the ones it cites, escrowing earnings to a fresh wallet the publisher can
 * later claim by onboarding. Keyless, graceful (falls back to seeds on failure).
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { registerDiscovered, type Source } from "./registry";

const FEEDS = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", pub: "CoinDesk", domain: "coindesk.com", bg: "#F7A600" },
  { url: "https://cointelegraph.com/rss", pub: "Cointelegraph", domain: "cointelegraph.com", bg: "#0A0A0A" },
  { url: "https://decrypt.co/feed", pub: "Decrypt", domain: "decrypt.co", bg: "#2D2DF7" },
  { url: "https://www.pymnts.com/feed/", pub: "PYMNTS", domain: "pymnts.com", bg: "#E11D48" },
  { url: "https://www.theblock.co/rss.xml", pub: "The Block", domain: "theblock.co", bg: "#0F172A" },
  { url: "https://cryptoslate.com/feed/", pub: "CryptoSlate", domain: "cryptoslate.com", bg: "#1E3A8A" },
  { url: "https://bitcoinmagazine.com/feed", pub: "Bitcoin Magazine", domain: "bitcoinmagazine.com", bg: "#F7931A" },
];

const FETCH_TIMEOUT_MS = 8000;
const STOP = new Set("the a an and or of to in for on at by is are was were be as with that this it from has have will not into over what why how does do".split(" "));

function strip(s: string): string {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return m ? strip(m[1]) : "";
}
function toks(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 3 && !STOP.has(t)));
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export interface Article {
  title: string;
  desc: string;
  link: string;
  pub: string;
  domain: string;
  bg: string;
}

/** Parse RSS <item>s into articles. Pure (no network) so it can be unit-tested. */
export function parseFeedItems(
  xml: string,
  meta: { pub: string; domain: string; bg: string },
  max = 8,
): Article[] {
  const out: Article[] = [];
  const re = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi; // RSS <item> or Atom <entry>
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < max) {
    const b = m[1];
    const title = tag(b, "title").slice(0, 90);
    const desc = (tag(b, "description") || tag(b, "content:encoded") || tag(b, "summary")).slice(0, 320);
    // RSS <link>url</link> or Atom <link href="url"/>
    const link = (tag(b, "link") || (/<link[^>]*href=["']([^"']+)["']/i.exec(b)?.[1] ?? "")).slice(0, 200);
    if (title && desc && link.startsWith("http")) {
      out.push({ title, desc, link, pub: meta.pub, domain: meta.domain, bg: meta.bg });
    }
  }
  return out;
}

// Short in-memory cache so repeated Live-web runs are fast and don't re-hammer
// the publisher feeds.
const FEED_CACHE_TTL_MS = 60_000;
const feedCache = new Map<string, { at: number; items: Article[] }>();

async function fetchFeed(feed: (typeof FEEDS)[number]): Promise<Article[]> {
  const cached = feedCache.get(feed.url);
  if (cached && Date.now() - cached.at < FEED_CACHE_TTL_MS) return cached.items;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MeritAgent/1.0)" },
      signal: ctrl.signal,
    });
    if (!res.ok) return cached?.items ?? []; // serve stale on a transient error
    // Bound memory against a hostile/buggy feed streaming unbounded data: reject an oversized declared
    // Content-Length, then hard-cap the body read (RSS feeds are KBs; 5MB is a generous ceiling — the
    // abort-timeout above bounds slow streams). The real feeds are UTF-8, so a plain decode is correct.
    const MAX_FEED_BYTES = 5 * 1024 * 1024;
    if (Number(res.headers.get("content-length") || 0) > MAX_FEED_BYTES) return cached?.items ?? [];
    let body: string;
    const reader = res.body?.getReader();
    if (!reader) {
      body = await res.text();
    } else {
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        received += r.value.length;
        if (received > MAX_FEED_BYTES) { ctrl.abort(); return cached?.items ?? []; }
        chunks.push(r.value);
      }
      body = Buffer.concat(chunks).toString("utf8");
    }
    const items = parseFeedItems(body, feed);
    feedCache.set(feed.url, { at: Date.now(), items });
    return items;
  } catch {
    return cached?.items ?? []; // serve stale on timeout/network error
  } finally {
    clearTimeout(t);
  }
}

function shortId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return "d_" + (h >>> 0).toString(36);
}

/** Discover ~`limit` real publisher articles for a question. Empty array on total failure. */
export async function discoverSources(question: string, limit = 6): Promise<Source[]> {
  const batches = await Promise.allSettled(FEEDS.map(fetchFeed));
  const pool = batches.flatMap((b) => (b.status === "fulfilled" ? b.value : []));
  if (pool.length === 0) return [];

  // Rank by relevance to the question, then take a natural mix: the most
  // relevant articles (the agent will cite + pay these) plus a couple of
  // low-relevance ones (the agent will genuinely refuse these as "not cited").
  const q = toks(question);
  const scored = pool
    .map((a) => ({ a, score: overlap(q, toks(a.title + " " + a.desc)) }))
    .sort((x, y) => y.score - x.score);
  const relevant = scored.filter((s) => s.score > 0).slice(0, Math.max(1, limit - 2)).map((s) => s.a);
  // If nothing in the live feeds is relevant to the question, return nothing so
  // the agent falls back to the curated pool (rather than refusing every source).
  if (relevant.length === 0) return [];
  const offtopic = scored.filter((s) => s.score === 0).slice(0, 2).map((s) => s.a);
  const picked = dedupe([...relevant, ...offtopic]).slice(0, limit);

  const palette = ["#F7A600", "#0A0A0A", "#2D2DF7", "#0EA5E9", "#8B5CF6", "#0891B2"];
  const sources: Source[] = picked.map((a, i) => {
    // Receive-only payout address — derive it, discard the key (a publisher only RECEIVES).
    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    return {
      id: shortId(a.link),
      name: a.title,
      handle: a.domain,
      kind: "Publisher",
      initials: a.pub.slice(0, 2).toUpperCase(),
      avatarBg: a.bg || palette[i % palette.length],
      merit: 70,
      price: 0.012,
      wallet,
      content: `${a.title}. ${a.desc}`,
      verified: true, // recognized publisher domain → passes the identity gate
      balance: 0,
    };
  });

  registerDiscovered(sources);
  return sources;
}

function dedupe(arr: Article[]): Article[] {
  const seenLink = new Set<string>();
  const seenTitle = new Set<string>();
  return arr.filter((a) => {
    const tk = a.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seenLink.has(a.link) || seenTitle.has(tk)) return false;
    seenLink.add(a.link);
    seenTitle.add(tk);
    return true;
  });
}
