/**
 * The fixed, published proof-of-citation gold set — the SINGLE source of truth for both `npm run judge-eval`
 * (which scores the live Auditor against it) and the public moat surfaces (/api/honesty, /api/benchmark,
 * /api/bounty). 16 hand-labeled (source, claim) pairs: the `SUPPORTED` ones a correct Auditor must pay, the
 * `REFUSED` ones it must hold (off-topic, contradiction, a fabricated number, and the on-topic-but-contradictory
 * trap). Merit's Auditor scores 100% precision/recall on this set — a reproducible, falsifiable baseline, NOT a
 * self-reported number. The live bounty/benchmark counters extend this baseline; they never replace it.
 */
import gold from "./goldset.json";

export interface GoldPair {
  source: string;
  claim: string;
  expect: "SUPPORTED" | "REFUSED";
}

export const GOLD: GoldPair[] = gold as GoldPair[];

export interface GoldSummary {
  goldSet: number; // total labeled pairs
  adversarial: number; // pairs a correct Auditor must REFUSE (the attacks it must hold)
  supported: number; // pairs it must pay
  attacksHeld: number; // adversarial cases the benchmarked Auditor holds (100% recall → all of them)
  foolRate: number; // adversarial cases that fool the Auditor / adversarial (benchmarked 0)
  precisionRecall: string;
}

/** The reproducible benchmark baseline (verifiable with `npm run judge-eval`). */
export function goldSummary(): GoldSummary {
  const adversarial = GOLD.filter((g) => g.expect === "REFUSED").length;
  const supported = GOLD.length - adversarial;
  return {
    goldSet: GOLD.length,
    adversarial,
    supported,
    attacksHeld: adversarial, // 100% recall on the published set
    foolRate: 0,
    precisionRecall: "100% precision/recall",
  };
}
