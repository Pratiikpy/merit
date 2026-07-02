// QA accessibility scan (TEST-PLAN §13) — injects axe-core into every public page and reports WCAG 2.1 A/AA
// violations. Writes qa-a11y-report.md. Run: QA_BASE=https://merit-ecru.vercel.app node scripts/qa-a11y.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const BASE = process.env.QA_BASE || "https://merit-ecru.vercel.app";
const PAGES = ["/", "/break.html", "/honesty.html", "/benchmark.html", "/onboard.html", "/passport.html", "/brandkit"];

const browser = await chromium.launch();
const all = [];
console.log(`\n=== axe-core WCAG 2.1 A/AA — ${BASE} ===\n`);
for (const p of PAGES) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try { await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 45000 }); } catch { try { await page.goto(BASE + p, { waitUntil: "domcontentloaded", timeout: 45000 }); } catch {} }
  await page.waitForTimeout(2000);
  await page.addScriptTag({ content: axeSource });
  const res = await page.evaluate(async () => await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
  const v = res.violations.map((x) => ({ id: x.id, impact: x.impact, n: x.nodes.length, help: x.help }));
  all.push({ page: p, violations: v });
  console.log(`${v.length ? "[⚠]" : "[ok]"} ${p} — ${v.length} violation types${v.length ? ": " + v.map((x) => `${x.id}(${x.impact}×${x.n})`).join(", ") : ""}`);
  await ctx.close();
}
await browser.close();

const total = all.reduce((s, a) => s + a.violations.length, 0);
const serious = all.flatMap((a) => a.violations).filter((v) => v.impact === "critical" || v.impact === "serious");
const lines = [`# Merit — accessibility (axe-core WCAG 2.1 A/AA)`, ``, `Target: **${BASE}** · **${total} violation type(s)** across ${PAGES.length} pages · **${serious.length} critical/serious**.`, ``];
for (const a of all) {
  lines.push(`## ${a.page} — ${a.violations.length ? a.violations.length + " violation type(s)" : "✅ none"}`);
  for (const v of a.violations) lines.push(`- ${v.impact === "critical" || v.impact === "serious" ? "🟠" : "🟡"} **${v.id}** (${v.impact}, ${v.n} node(s)) — ${v.help}`);
}
fs.writeFileSync("qa-a11y-report.md", lines.join("\n") + "\n");
console.log(`\n=== ${total} violation types (${serious.length} critical/serious) — wrote qa-a11y-report.md ===`);
