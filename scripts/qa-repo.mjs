// QA repo/docs public-surface audit (TEST-PLAN §18). Scans every public markdown doc for broken links,
// leaked secrets, AI-slop/placeholder copy, and checks .env.example carries no real values. Writes
// qa-repo-report.md. Run: node scripts/qa-repo.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const findings = [];
const add = (sev, where, msg) => findings.push({ sev, where, msg });

// Scan the product's public docs; skip the QA meta-docs (they legitimately discuss "TODO/placeholder/slop"
// as things to CHECK FOR, which would be false positives) and the internal HUMAN.md (gitignored).
const DOCS = fs.readdirSync(ROOT).filter((f) => f.endsWith(".md") && !f.startsWith("TEST-PLAN") && f !== "HUMAN.md" && !f.endsWith("-report.md"));
for (const d of ["docs"]) { try { for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith(".md")) DOCS.push(path.join(d, f)); } catch {} }

// secret patterns (real keys must never appear in a public doc)
const SECRETS = [
  [/\bnvapi-[A-Za-z0-9_-]{20,}/g, "NVIDIA API key"],
  [/\bhf_[A-Za-z0-9]{20,}/g, "HuggingFace token"],
  [/\bsk-[A-Za-z0-9]{20,}/g, "OpenAI-style secret key"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "PEM private key"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, "JWT (service-role?)"],
];
// a bare 0x + 64 hex in a doc is a likely private key (verdict hashes live in code/API, not prose)
const PRIVKEY = /\b0x[0-9a-fA-F]{64}\b/g;
// AI-slop / placeholder copy (conservative — em-dashes are intentional brand voice here, NOT flagged)
const SLOP = [/\bas an ai\b/i, /\blorem ipsum\b/i, /\bTODO\b/, /\bFIXME\b/, /\bXXX\b/, /\bplaceholder\b/i, /\bdelve\b/i, /in today's fast-paced/i, /\bcertainly!/i];

const httpLinks = new Set();
for (const rel of DOCS) {
  const p = path.join(ROOT, rel);
  const txt = fs.readFileSync(p, "utf8");
  for (const [re, label] of SECRETS) if (re.test(txt)) add("BLOCKER", rel, `possible leaked secret: ${label}`);
  const pk = txt.match(PRIVKEY);
  if (pk) add("BLOCKER", rel, `possible private key in prose: ${pk[0].slice(0, 12)}…`);
  for (const re of SLOP) { const m = txt.match(re); if (m) add("MED", rel, `AI-slop/placeholder copy: "${m[0]}"`); }
  // links + images
  for (const m of txt.matchAll(/\]\((\s*[^)]+?)\)/g)) {
    const href = m[1].trim().split(" ")[0];
    if (/^https?:\/\//.test(href)) httpLinks.add(href.replace(/[.,)]+$/, ""));
    else if (!href.startsWith("#") && !href.startsWith("mailto:")) {
      const target = path.join(ROOT, href.split("#")[0]);
      if (!fs.existsSync(target)) add("HIGH", rel, `broken relative link/image: ${href}`);
    }
  }
  // HTML <img src> (README uses them)
  for (const m of txt.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const src = m[1];
    if (!/^https?:\/\//.test(src)) { if (!fs.existsSync(path.join(ROOT, src))) add("HIGH", rel, `broken <img>: ${src}`); }
  }
}

// .env.example must carry placeholders, not real values
try {
  const env = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  for (const [re, label] of SECRETS) if (re.test(env)) add("BLOCKER", ".env.example", `real secret present: ${label}`);
  if (PRIVKEY.test(env)) add("BLOCKER", ".env.example", "real private key present");
} catch { add("MED", ".env.example", "missing (document required env vars)"); }

// external link health (HEAD, then GET fallback)
console.log(`\n=== repo/docs audit — ${DOCS.length} docs, ${httpLinks.size} external links ===\n`);
for (const url of httpLinks) {
  if (/img.shields.io|badge/.test(url)) continue; // badges are dynamic images, skip
  try {
    let r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (r.status === 405 || r.status === 403) r = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (r.status >= 400) add("HIGH", "link", `${r.status} ${url}`);
    else console.log(`[ok ${r.status}] ${url}`);
  } catch (e) { add("HIGH", "link", `unreachable ${url} (${String(e.message).slice(0, 40)})`); }
}

const bySev = (s) => findings.filter((f) => f.sev === s);
const lines = [`# Merit — repo/docs public-surface audit`, ``, `Docs scanned: ${DOCS.join(", ")}`, ``,
  `**🔴 ${bySev("BLOCKER").length} blocker · 🟠 ${bySev("HIGH").length} high · 🟡 ${bySev("MED").length} med**`, ``];
for (const f of findings) lines.push(`- ${f.sev === "BLOCKER" ? "🔴" : f.sev === "HIGH" ? "🟠" : "🟡"} **${f.where}** — ${f.msg}`);
if (!findings.length) lines.push(`✅ No issues: no leaked secrets, no broken links/images, no AI-slop/placeholder copy.`);
fs.writeFileSync("qa-repo-report.md", lines.join("\n") + "\n");
console.log(`\n=== 🔴 ${bySev("BLOCKER").length} · 🟠 ${bySev("HIGH").length} · 🟡 ${bySev("MED").length} — wrote qa-repo-report.md ===`);
