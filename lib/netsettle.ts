/**
 * Verified net settlement (closes Phase 2). An agent that cited N sources in one piece of work wants to pay them
 * in a single batch — but Merit nets that batch down to the VERIFIED subset: it verifies every line, settles only
 * the ones whose delivered content actually supports its claim, and quarantines (never pays) the rest. The buyer
 * authorizes N and pays only the k that verify. This is the batch analog of /api/buy: buy picks the best single
 * source among alternatives; net settlement pays a whole basket, filtered by correctness. Each settled line is a
 * signed receipt; the settlement reuses the same custody + reputation + history rails as the citation toll.
 */
import { verifyCitation, isVerifyError, type VerifyOptions } from "./verify/engine";
import { accrueCustody } from "./custody";
import { applyOutcome } from "./registry";
import { recordSettlement } from "./history";
import { cardFromVerdict, saveCard } from "./cards";
import { round6 } from "./arc";

export interface BatchItemResolved {
  sourceId?: string; // registry source id (settlement target); omitted for a purely inline line
  sourceName: string;
  content: string; // the delivered content Merit verifies against the claim
  claim: string;
  amount: number; // USDC authorized for this line
  domain?: string; // custody claim domain, if the source proved one
  sourceUrl?: string;
}

export interface BatchLine {
  sourceName: string;
  claim: string;
  amount: number;
  verdict: "SUPPORTED" | "REFUSED" | "error";
  settled: boolean;
  verificationId?: string;
  receiptId?: string;
  reason?: string;
}

export interface BatchResult {
  lines: BatchLine[];
  count: number;
  settledCount: number;
  quarantinedCount: number;
  totalAuthorized: number;
  totalSettled: number;
  totalQuarantined: number;
}

/** Pure roll-up over a set of resolved lines and their verdicts — totals authorized, settled, and quarantined. */
export function summarize(lines: BatchLine[]): Omit<BatchResult, "lines"> {
  let totalAuthorized = 0;
  let totalSettled = 0;
  let totalQuarantined = 0;
  let settledCount = 0;
  for (const l of lines) {
    totalAuthorized = round6(totalAuthorized + l.amount);
    if (l.settled) {
      totalSettled = round6(totalSettled + l.amount);
      settledCount += 1;
    } else {
      totalQuarantined = round6(totalQuarantined + l.amount);
    }
  }
  return {
    count: lines.length,
    settledCount,
    quarantinedCount: lines.length - settledCount,
    totalAuthorized,
    totalSettled,
    totalQuarantined,
  };
}

/** Verify every line and settle only the SUPPORTED ones (custody accrual + reputation + history + a signed
 *  receipt), quarantining the rest. Sequential so a large batch can't fan out into a burst of judge calls. */
export async function settleVerifiedBatch(items: BatchItemResolved[], opts: { verify?: VerifyOptions } = {}): Promise<BatchResult> {
  const verifyOpts: VerifyOptions = opts.verify ?? { useNLI: true, useJudge: true };
  const lines: BatchLine[] = [];

  for (const it of items) {
    const out = await verifyCitation(it.claim, it.content, verifyOpts);
    if (isVerifyError(out)) {
      lines.push({ sourceName: it.sourceName, claim: it.claim, amount: it.amount, verdict: "error", settled: false, reason: out.error });
      continue;
    }
    const v = out.verdict;
    const card = saveCard(
      cardFromVerdict(v, {
        kind: v.verdict === "SUPPORTED" ? "settlement" : "verify",
        source: it.content,
        sourceUrl: it.sourceUrl,
        sourceName: it.sourceName,
        custody: v.verdict === "SUPPORTED",
        paidUsdc: v.verdict === "SUPPORTED" ? it.amount : undefined,
        createdAt: new Date().toISOString(),
      }),
    );

    if (v.verdict === "SUPPORTED") {
      // Settle this line to the source — real custody accrual, claimable on-chain via domain proof.
      accrueCustody(it.sourceId || it.sourceName, it.sourceName, it.amount, it.domain ? { domain: it.domain } : undefined);
      if (it.sourceId) {
        try {
          applyOutcome(it.sourceId, { meritDelta: 1, earned: it.amount });
          recordSettlement({ runId: "batch", sourceId: it.sourceId, cited: true, released: true, amount: it.amount, confidence: v.score ?? 0, reason: "batch:custody", at: Date.now() });
        } catch {
          /* reputation/history update is best-effort */
        }
      }
      lines.push({ sourceName: it.sourceName, claim: it.claim, amount: it.amount, verdict: v.verdict, settled: true, verificationId: v.verificationId, receiptId: card.id });
    } else {
      // Did not verify — quarantine it, pay nothing.
      lines.push({ sourceName: it.sourceName, claim: it.claim, amount: it.amount, verdict: v.verdict, settled: false, verificationId: v.verificationId, receiptId: card.id, reason: v.reason });
    }
  }

  return { lines, ...summarize(lines) };
}
