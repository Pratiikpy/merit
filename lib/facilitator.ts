/**
 * Verify-gated x402 facilitator (cat 1, the moat move) — the generic "pay ANY x402 seller, but only trust the
 * payment if the delivered work actually verifies" primitive. Payment rails (x402, Stripe ACP) move the money
 * the instant the HTTP call succeeds; none check the delivered work is correct. Merit wraps the generic
 * X-PAYMENT client with the verifier: probe the seller's terms, pay within a hard ceiling, run the delivered
 * content through the citation verifier against the claim it was supposed to support, and return a signed
 * verdict + a keep/dispute recommendation. Same verifier core as the inference and toll doors.
 *
 * Reuses the production-proven payAndFetch (also used by /api/score) + verifyCitation — no duplicated logic.
 *
 * POST /api/facilitator { url, claim, maxUsdc? }
 *   → probe (stub / unpayable) OR { settled, paid, verdict, verified, recommendation: "keep" | "dispute" }
 */
import { supportsPayment, payAndFetch } from "./pay";
import { verifyCitation, isVerifyError } from "./verify/engine";
import { isStub } from "./arc";
import { assertPublicHost } from "./ssrf";

const MAX_CONTENT = 20000;

export interface FacilitatorResult {
  mode: "probe" | "settled";
  url: string;
  support: { supported: boolean; priceUsdc: number | null; error?: string | null };
  paid?: { amount: number; transaction: string; explorerUrl: string; onchain: boolean };
  verdict?: "SUPPORTED" | "REFUSED";
  verified?: boolean;
  verificationId?: string;
  recommendation?: "keep" | "dispute";
  note: string;
}

function asText(data: unknown): string {
  if (typeof data === "string") return data.slice(0, MAX_CONTENT);
  try {
    return JSON.stringify(data).slice(0, MAX_CONTENT);
  } catch {
    return "";
  }
}

/** Probe → (live) pay within the ceiling → verify the delivered content → keep/dispute verdict. */
export async function facilitate(input: { url: string; claim: string; maxUsdc?: number }): Promise<{ result: FacilitatorResult } | { error: string; status: number }> {
  const url = (input.url || "").trim();
  const claim = (input.claim || "").trim();
  if (!url) return { error: "provide an x402 seller { url }", status: 400 };
  if (!claim) return { error: "provide the { claim } the delivered content is supposed to support", status: 400 };
  if (!/^https?:\/\//.test(url)) return { error: "url must start with http(s)://", status: 400 };
  // SSRF guard BEFORE any probe: resolve+validate the host so we never make even a blind request to an
  // internal/loopback/link-local/cloud-metadata target (169.254.169.254, 10./172.16./192.168., ::1, …).
  try {
    await assertPublicHost(new URL(url).hostname);
  } catch {
    return { error: "that host isn't allowed", status: 400 };
  }
  const maxUsdc = Number.isFinite(input.maxUsdc) && (input.maxUsdc as number) > 0 ? (input.maxUsdc as number) : 0.05;

  const support = await supportsPayment(url).catch((e) => ({ supported: false, priceUsdc: null as number | null, error: (e as Error).message }));

  // In stub mode (or when the endpoint isn't payable) we can't settle a real toll — probe + explain honestly.
  if (isStub() || !support.supported) {
    return {
      result: {
        mode: "probe",
        url,
        support,
        note: isStub()
          ? "Stub mode cannot settle a real external toll. Live, Merit would pay this seller within your ceiling, verify the delivered content against your claim, and recommend keep or dispute — you never trust a payment for work that doesn't verify."
          : support.error || "Endpoint does not accept a payment scheme Merit can settle.",
      },
    };
  }

  // Live: pay within the ceiling, then verify what we paid for.
  let paid;
  try {
    paid = await payAndFetch(url, maxUsdc);
  } catch (e) {
    return { error: `payment failed: ${(e as Error).message.slice(0, 120)}`, status: 502 };
  }
  const outcome = await verifyCitation(claim, asText(paid.data), {});
  if (isVerifyError(outcome)) {
    return {
      result: {
        mode: "settled",
        url,
        support: { supported: support.supported, priceUsdc: support.priceUsdc },
        paid: { amount: paid.amount, transaction: paid.transaction, explorerUrl: paid.explorerUrl, onchain: paid.onchain },
        note: `Paid ${paid.amount} USDC but could not verify the delivered content: ${outcome.error}. Recommend dispute.`,
        recommendation: "dispute",
      },
    };
  }
  const v = outcome.verdict;
  const verified = v.verdict === "SUPPORTED";
  return {
    result: {
      mode: "settled",
      url,
      support: { supported: support.supported, priceUsdc: support.priceUsdc },
      paid: { amount: paid.amount, transaction: paid.transaction, explorerUrl: paid.explorerUrl, onchain: paid.onchain },
      verdict: v.verdict,
      verified,
      verificationId: v.verificationId,
      recommendation: verified ? "keep" : "dispute",
      note: verified
        ? `Paid ${paid.amount} USDC and the delivered content verifies against your claim — keep it.`
        : `Paid ${paid.amount} USDC but the delivered content does NOT support your claim — dispute it. A rail that pays on HTTP-200 would have trusted this blindly.`,
    },
  };
}
