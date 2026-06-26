const feeds = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
];

function strip(s) {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tag(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return m ? strip(m[1]) : "";
}
function parse(xml, n = 3) {
  const out = [];
  const re = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && out.length < n) {
    const b = m[1];
    out.push({
      title: tag(b, "title").slice(0, 90),
      desc: (tag(b, "description") || tag(b, "content:encoded")).slice(0, 200),
      link: tag(b, "link").slice(0, 70),
    });
  }
  return out;
}

for (const f of feeds) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(f, { headers: { "User-Agent": "Mozilla/5.0 MeritBot" }, signal: ctrl.signal });
    clearTimeout(t);
    const xml = await res.text();
    const items = parse(xml);
    console.log(`\nFEED ${f}  [${res.status}]  items=${items.length}`);
    items.forEach((i, n) => console.log(`  [${n}] ${i.title}\n      ${i.desc}\n      ${i.link}`));
  } catch (e) {
    console.log(`\nFEED ${f}  ERROR ${e.message}`);
  }
}
