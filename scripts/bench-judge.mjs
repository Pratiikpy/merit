#!/usr/bin/env node
/**
 * bench-judge — measure the verification engine's citation-faithfulness accuracy against a labeled dataset,
 * the honest replacement for any hardcoded "100% precision/recall".
 *
 * It POSTs each (claim, source) pair to the running server's CVO (`/api/verify`, same path production uses),
 * compares the verdict to the gold label, and reports a real confusion matrix: precision / recall / F1 /
 * balanced accuracy — plus COVERAGE (pairs the engine could decide vs pairs it abstained on because no
 * LLM/NLI was configured). Coverage is reported, never hidden: numeric-only deployments decide only numeric
 * pairs, and that's stated rather than inflated to 100%.
 *
 * Usage:
 *   npm run start                      # (in another shell) serve the app
 *   npm run bench-judge                # scores lib/goldset.json by default
 *   MERIT_BASE=http://localhost:3000 BENCH_SET=benchmark/ragtruth.json npm run bench-judge
 *
 * Dataset format (JSON array): [{ "source": "...", "claim": "...", "expect": "SUPPORTED"|"REFUSED" }, ...]
 * Add RAGTruth / FaithBench under benchmark/ (see benchmark/README.md) for published-grade numbers.
 * Results are written to benchmark/results.json (consumed by the public benchmark surface).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const SET = process.env.BENCH_SET || "lib/goldset.json";

function loadSet(rel) {
  const p = path.resolve(APP_ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error(`dataset not found: ${p}\nSee benchmark/README.md to add RAGTruth/FaithBench, or run with the default lib/goldset.json.`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const rows = (Array.isArray(raw) ? raw : raw.pairs || []).map((r) => ({
    source: r.source ?? r.context ?? r.document,
    claim: r.claim ?? r.statement ?? r.response,
    expect: (r.expect ?? r.label ?? "").toUpperCase(),
  }));
  return rows.filter((r) => r.source && r.claim && (r.expect === "SUPPORTED" || r.expect === "REFUSED"));
}

async function verifyOne(claim, source) {
  try {
    const r = await fetch(`${BASE}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim, source }),
    });
    if (r.status === 503) return { abstain: true }; // judge/NLI unavailable → honest abstain, not a guess
    if (!r.ok) return { error: `${r.status}` };
    const d = await r.json();
    const v = (d.verdict || "").toUpperCase();
    return v === "SUPPORTED" || v === "REFUSED" ? { verdict: v } : { error: "no verdict" };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

function metrics(tp, fp, tn, fn) {
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null;
  const tnr = tn + fp ? tn / (tn + fp) : null;
  const balancedAcc = recall != null && tnr != null ? (recall + tnr) / 2 : null;
  return { precision, recall, f1, balancedAcc };
}

const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);

async function main() {
  const rows = loadSet(SET);
  console.log(`bench-judge · ${rows.length} labeled pairs · set=${SET} · base=${BASE}`);
  // Convention: positive class = REFUSED (catching an unsupported/hallucinated citation is the job).
  let tp = 0, fp = 0, tn = 0, fn = 0, abstain = 0, errors = 0;
  for (const row of rows) {
    const res = await verifyOne(row.claim, row.source);
    if (res.abstain) { abstain++; continue; }
    if (res.error) { errors++; continue; }
    const predRefused = res.verdict === "REFUSED";
    const goldRefused = row.expect === "REFUSED";
    if (goldRefused && predRefused) tp++;
    else if (!goldRefused && predRefused) fp++;
    else if (!goldRefused && !predRefused) tn++;
    else fn++;
  }
  const decided = tp + fp + tn + fn;
  const coverage = rows.length ? decided / rows.length : 0;
  const m = metrics(tp, fp, tn, fn);
  const out = {
    set: SET,
    generatedAt: new Date().toISOString(),
    total: rows.length,
    decided,
    abstained: abstain,
    errors,
    coverage,
    confusion: { tp, fp, tn, fn, positiveClass: "REFUSED" },
    metrics: m,
    note:
      abstain > 0
        ? "Some pairs abstained (no LLM/NLI configured) — metrics are over DECIDED pairs only; set LLM_API_KEY or MERIT_NLI_URL for full coverage (see HUMAN.md)."
        : "Full coverage.",
  };
  const dir = path.resolve(APP_ROOT, "benchmark");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(out, null, 2));
  console.log(
    `\ncoverage ${pct(coverage)} (${decided}/${rows.length}; ${abstain} abstained, ${errors} errors)\n` +
      `precision ${pct(m.precision)} · recall ${pct(m.recall)} · F1 ${pct(m.f1)} · balanced-acc ${pct(m.balancedAcc)}\n` +
      `confusion tp=${tp} fp=${fp} tn=${tn} fn=${fn} (positive=REFUSED)\n` +
      `→ benchmark/results.json`,
  );
  if (errors > 0 && decided === 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
