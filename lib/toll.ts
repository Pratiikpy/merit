/**
 * Citation-toll x402 shim (W3) — a real HTTP 402 boundary that turns any Merit source into an x402-payable
 * resource. The pay-per-crawl industry settles per-CRAWL off-chain; this is the missing per-CITATION layer:
 * an AI agent that wants to ground an answer in a source hits a 402 with the x402 payment requirements, pays
 * on Arc, and the toll settles to the source author's wallet. Pure + deterministic so the decision (402 vs
 * pass) and the quote are unit-testable; the route (app/api/toll/[id]) wires it to real settlement.
 */
import { ARC } from "./arc";
import { effectivePrice } from "./pricing";
import type { Source } from "./registry";

// AI crawler / agent User-Agents that should be tolled (humans read free unless MERIT_TOLL_ALL=1).
const AGENT_UA =
  /(GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|PerplexityBot|Perplexity-User|CCBot|Google-Extended|Bytespider|Amazonbot|Applebot-Extended|cohere-ai|Diffbot|Meta-ExternalAgent|x402|MeritAgent|\bbot\b|crawler|spider)/i;

export function isAgentUA(ua: string): boolean {
  return !!ua && AGENT_UA.test(ua);
}

export interface TollQuote {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    payTo: string;
    maxAmountRequired: string; // atomic USDC (6 decimals)
    resource: string;
    description: string;
    mimeType: string;
    extra?: Record<string, unknown>;
  }>;
  source: { id: string; name: string; merit: number; priceUsdc: number };
}

/** Build the x402 payment requirements to cite `source` — priced by the source's (reputation-adjusted) rate,
 *  payable in USDC on Arc to the source's own wallet. */
export function tollQuote(source: Source, claim?: string): TollQuote {
  const price = effectivePrice(source.price, source.merit, source.priceMode);
  const atomic = Math.round(price * 1e6); // USDC has 6 decimals
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: ARC.network, // eip155:5042002
        asset: ARC.usdc,
        payTo: source.wallet,
        maxAmountRequired: String(atomic),
        resource: `merit:citation:${source.id}`,
        description: `Per-citation toll to ${source.name} — settled on Arc when an AI answer is grounded in this source.`,
        mimeType: "application/json",
        ...(claim ? { extra: { claim } } : {}),
      },
    ],
    source: { id: source.id, name: source.name, merit: source.merit, priceUsdc: price },
  };
}

export type TollDecision =
  | { status: 402; quote: TollQuote }
  | { status: 200; settle: boolean };

/** Decide whether a request must pay the toll. A present payment proof passes to settlement; otherwise an AI
 *  agent (by User-Agent) — or any request when `tollAll` — gets a 402 quote, while a human browser reads free. */
export function decideToll(req: { ua: string; payment: string | null; tollAll?: boolean }, source: Source): TollDecision {
  if (req.payment) return { status: 200, settle: true };
  if (req.tollAll || isAgentUA(req.ua)) return { status: 402, quote: tollQuote(source) };
  return { status: 200, settle: false };
}
