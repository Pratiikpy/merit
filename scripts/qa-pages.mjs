// QA page sweep — loads EVERY public page in a real browser and fails on anything a visitor would notice:
// a non-2xx status, a console error, a failed request, or horizontal overflow. A 200 alone is not a pass;
// a page that renders while its JS throws is still broken.
// Run: QA_BASE=https://www.onmerit.xyz node scripts/qa-pages.mjs
import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.QA_BASE || "https://www.onmerit.xyz";
const W = Number(process.env.QA_WIDTH) || 1280;   // QA_WIDTH=390 to sweep at phone width
const H = Number(process.env.QA_HEIGHT) || 900;
const pages = fs.readdirSync("public").filter(f => f.endsWith(".html")).map(f => "/" + f);
pages.unshift("/");                       // the rewritten landing page
const browser = await chromium.launch();
let bad = 0;
for (const p of pages) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  const errs = [], failed = [];
  page.on("console", m => { if (m.type() === "error") errs.push(m.text().slice(0, 120)); });
  page.on("pageerror", e => errs.push("PAGEERROR " + e.message.slice(0, 120)));
  page.on("requestfailed", r => { const f = r.failure()?.errorText || ""; if (!/ERR_ABORTED/.test(f)) failed.push(r.url().slice(0, 90) + " :: " + f); });
  let status = 0;
  try { const res = await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 45000 }); status = res?.status() ?? 0; }
  catch { try { const res = await page.goto(BASE + p, { waitUntil: "domcontentloaded", timeout: 30000 }); status = res?.status() ?? 0; } catch {} }
  await page.waitForTimeout(1500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth).catch(() => 0);
  const ok = status >= 200 && status < 400 && errs.length === 0 && failed.length === 0 && overflow <= 0;
  if (!ok) { bad++; console.log(`[FAIL] ${p} status=${status} overflow=${overflow}`); errs.slice(0,3).forEach(e => console.log("        console:", e)); failed.slice(0,3).forEach(e => console.log("        request:", e)); }
  else console.log(`[ok]   ${p}`);
  await ctx.close();
}
await browser.close();
console.log(`
=== ${pages.length} pages @ ${W}x${H} · ${bad} with problems ===`);
process.exit(bad ? 1 : 0);
