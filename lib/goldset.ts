/**
 * The published proof-of-citation gold set — the SINGLE source of truth for `npm run bench-judge` /
 * `judge-eval` (which score the live Auditor against it) and the public moat surfaces (/api/honesty,
 * /api/benchmark, /api/bounty). 275 (source, claim) pairs spanning 14 adversarial failure modes (fabricated
 * figures/percentages, direct contradiction, off-topic, right-entity-wrong-attribute, overgeneralization,
 * temporal error, negation/causation flip, unsupported addition, hard-borderline/rounding, prompt-injection,
 * plus supported direct/paraphrase/synthesis). Authored by diverse independent writers, then EACH label
 * blind-verified by two more independent annotators — only unanimous, unambiguous pairs were kept, so the
 * labels are trustworthy rather than one author's opinion. Split into a dev set (benchmark/goldset-dev.json)
 * and a held-out test set (benchmark/goldset-test.json). No hardcoded accuracy: `goldSummary()` computes
 * precision/recall from an ACTUAL measured run (benchmark/results.json) and reports "not yet measured" until
 * then. The whole product is honesty — the benchmark is falsifiable, reproducible, and never self-graded.
 */
import gold from "./goldset.json";
import fs from "node:fs";
import path from "node:path";

export interface GoldPair {
  source: string;
  claim: string;
  expect: "SUPPORTED" | "REFUSED";
  failureMode?: string; // the adversarial class this pair exercises (for per-failure-mode metrics)
  domain?: string; // topic domain, for diversity auditing
}

export const GOLD: GoldPair[] = gold as GoldPair[];

export interface GoldSummary {
  goldSet: number; // total labeled pairs in the fixed gold set
  adversarial: number; // pairs a correct verifier must REFUSE
  supported: number; // pairs it must pay
  measured: boolean; // true only if benchmark/results.json exists (an actual `npm run bench-judge` run)
  attacksHeld: number; // adversarial pairs the verifier ACTUALLY held (measured tp); 0 until measured
  foolRate: number | null; // measured adversarial-slip rate (1 - recall); null until measured
  precisionRecall: string; // measured "P/R", or an honest "not yet measured" marker
  benchmark: { set: string; coverage: number; total: number; decided: number } | null;
}

interface BenchResults {
  set?: string;
  coverage?: number;
  total?: number;
  decided?: number;
  metrics?: { precision: number | null; recall: number | null; f1: number | null; balancedAcc: number | null };
  confusion?: { tp: number; fp: number; tn: number; fn: number };
}

/** Read measured metrics written by `npm run bench-judge` (benchmark/results.json), or null if never run. */
function readBenchResults(): BenchResults | null {
  try {
    const p = path.join(process.cwd(), "benchmark", "results.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as BenchResults;
  } catch {
    return null;
  }
}

const asPct = (x: number | null | undefined): string => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);

/**
 * Structural composition of the fixed gold set + HONEST benchmark metrics. Precision/recall are reported ONLY
 * from an actual measured run (benchmark/results.json via `npm run bench-judge`); until then the summary says
 * "not yet measured" rather than asserting a number. No hardcoded accuracy — the whole product is honesty.
 */
export function goldSummary(): GoldSummary {
  const adversarial = GOLD.filter((g) => g.expect === "REFUSED").length;
  const supported = GOLD.length - adversarial;
  const r = readBenchResults();
  if (r && r.metrics) {
    const tp = r.confusion?.tp ?? 0;
    const fn = r.confusion?.fn ?? 0;
    const denom = tp + fn;
    return {
      goldSet: GOLD.length,
      adversarial,
      supported,
      measured: true,
      attacksHeld: tp,
      foolRate: denom > 0 ? fn / denom : null,
      precisionRecall: `${asPct(r.metrics.precision)}/${asPct(r.metrics.recall)} precision/recall`,
      benchmark: {
        set: r.set ?? "unknown",
        coverage: r.coverage ?? 0,
        total: r.total ?? 0,
        decided: r.decided ?? 0,
      },
    };
  }
  return {
    goldSet: GOLD.length,
    adversarial,
    supported,
    measured: false,
    attacksHeld: 0,
    foolRate: null,
    precisionRecall: "not yet measured — run `npm run bench-judge`",
    benchmark: null,
  };
}
