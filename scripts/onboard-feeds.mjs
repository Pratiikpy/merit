/**
 * Batch-onboard REAL public publisher feeds as Merit creators (the keryx-style permissionless listing).
 *   node scripts/onboard-feeds.mjs [baseUrl]
 * Real feeds → real citable content + a receive-only wallet + ERC-8004 identity each. Honest: these are
 * permissionless listings (the publishers haven't opted in via merit-verify), not opted-in users. Writes
 * PUBLISHERS.md listing every one that onboarded.
 */
const base = process.argv[2] || process.env.MERIT_BASE || "http://localhost:3014";

const FEEDS = [
  "https://huggingface.co/blog/feed.xml",
  "https://hnrss.org/frontpage",
  "http://export.arxiv.org/rss/cs.AI",
  "https://simonwillison.net/atom/everything/",
  "https://blog.cloudflare.com/rss/",
  "https://github.blog/feed/",
  "https://www.theverge.com/rss/index.xml",
  "https://techcrunch.com/feed/",
  "https://blog.ethereum.org/en/feed.xml",
  "https://a16z.com/feed/",
  "https://krebsonsecurity.com/feed/",
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "http://www.aaronsw.com/2002/feeds/pgessays.rss",
  "https://vitalik.eth.limo/feed.xml",
  "https://openai.com/news/rss.xml",
  "https://stackoverflow.blog/feed/",
  "https://www.wired.com/feed/rss",
  "https://feeds.arstechnica.com/arstechnica/index",
];

import { writeFileSync } from "node:fs";

const ok = [];
console.log(`\n  Onboarding ${FEEDS.length} real public feeds → ${base}\n`);
for (const url of FEEDS) {
  try {
    const r = await fetch(`${base}/api/creators/from-feed`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feedUrl: url }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { ok.push({ ...d, feed: url }); console.log(`  ✓ ${String(d.name).slice(0, 36).padEnd(36)} ${d.entries} entries  ${d.wallet}  #${d.agentId ?? "—"}`); }
    else console.log(`  ✗ ${url.replace(/^https?:\/\//, "").slice(0, 40)} — ${d.error || r.status}`);
  } catch (e) { console.log(`  ✗ ${url.replace(/^https?:\/\//, "").slice(0, 40)} — ${e.message?.slice(0, 50)}`); }
}

console.log(`\n  ✓ ${ok.length}/${FEEDS.length} real publisher feeds onboarded.\n`);

const md = `# Publishers on Merit

*${ok.length} real public feeds indexed as citable creators. **Honest disclosure:** these are permissionless
listings — real publisher content with Merit-generated receive-only wallets; the publishers have not opted in
via a \`merit-verify:\` marker (the same model keryx used for its public feeds). An owner-verified creator is a
stronger signal; this is the open-listing tier.*

| publisher | feed | payout wallet | ERC-8004 |
|---|---|---|---|
${ok.map((p) => `| ${p.name} | \`${p.feed.replace(/^https?:\/\//, "").slice(0, 40)}\` | \`${p.wallet}\` | #${p.agentId ?? "—"} |`).join("\n")}

Each earns USDC on Arc when a Merit agent **verifiably** cites its work. Onboard your own at \`/onboard.html\`.
`;
writeFileSync("PUBLISHERS.md", md);
console.log(`  → wrote PUBLISHERS.md (${ok.length} feeds)\n`);
