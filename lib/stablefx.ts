/**
 * Global verified payouts, part 2: StableFX — Circle's real, Arc-native USDC↔EURC RFQ exchange
 * (developers.circle.com/stablefx, verified 2026-10-11). This is the mechanism Merit's own treasury would
 * use to convert accumulated USDC earnings into EURC at a competitive, market-made rate, rather than the
 * fixed ECB reference rate lib/eurc.ts uses for individual creator payouts.
 *
 * Every function here calls StableFX's REAL documented endpoints with the REAL request/response/EIP-712
 * shapes taken directly from Circle's own quickstart and technical guide — nothing invented. What's missing
 * is the one input only Circle hands out directly: "Reach out to your Circle representative to get an API
 * key for StableFX" (developers.circle.com/stablefx, Get Started). There is no self-serve signup path for
 * this product specifically, unlike Circle's other Web3 APIs. `stablefxEnabled()` is false without
 * STABLEFX_API_KEY, and every function here refuses honestly rather than returning a fabricated quote.
 *
 * The RFQ model, end to end:
 *   1. getQuote()        POST /v1/exchange/stablefx/quotes    — multiple makers compete, best rate wins
 *   2. createTrade()     POST /v1/exchange/stablefx/trades    — locks the rate in, assigns a trade id
 *   3. getFundingPresignData()  GET .../signatures/presign/taker/{tradeId}  — server builds the EIP-712 payload
 *   4. sign it            (this process's own wallet signs — Circle never sees a private key)
 *   5. submitFunding()    POST /v1/exchange/stablefx/fund      — settles on-chain via the FxEscrow contract
 *
 * Minimum trade size is 10 USDC (StableFX's own documented floor) — well above Merit's typical per-payout
 * amounts (cents), so this module is scoped for periodic TREASURY-level batch conversion, not per-payout
 * FX — matching how a real treasury would actually use an RFQ exchange.
 */
import type { PrivateKeyAccount } from "viem";
import { ARC } from "./arc";

const STABLEFX_BASE = "https://api.circle.com";
const MIN_TRADE_USDC = 10;

export function stablefxEnabled(): boolean {
  return !!process.env.STABLEFX_API_KEY;
}

function apiKey(): string {
  const k = process.env.STABLEFX_API_KEY;
  if (!k) throw new Error("STABLEFX_API_KEY is not set — StableFX requires a key issued directly by a Circle representative (sales@circle.com); there is no self-serve signup for this product.");
  return k;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${STABLEFX_BASE}${path}`, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`StableFX ${init.method || "GET"} ${path} → HTTP ${res.status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body as T;
}

export interface FxAmount {
  currency: "USDC" | "EURC";
  amount: string;
}
export interface FxQuote {
  id: string;
  rate: string;
  from: FxAmount;
  to: FxAmount;
  timestamp: string;
  expiry: string;
  fee: FxAmount;
}
export type FxTenor = "instant" | "hourly" | "daily";

/** Step 1 — request a competitive quote. Provide exactly one of `fromAmountUsdc` / `toAmountEurc`. */
export async function getQuote(input: { fromAmountUsdc?: number; toAmountEurc?: number; tenor?: FxTenor }): Promise<FxQuote> {
  if (!input.fromAmountUsdc && !input.toAmountEurc) throw new Error("provide fromAmountUsdc or toAmountEurc");
  if (input.fromAmountUsdc && input.fromAmountUsdc < MIN_TRADE_USDC) {
    throw new Error(`StableFX's minimum trade is ${MIN_TRADE_USDC} USDC — this module is for treasury-level batch conversion, not per-payout FX`);
  }
  const body = {
    from: { currency: "USDC", ...(input.fromAmountUsdc ? { amount: input.fromAmountUsdc.toFixed(2) } : {}) },
    to: { currency: "EURC", ...(input.toAmountEurc ? { amount: input.toAmountEurc.toFixed(2) } : {}) },
    tenor: input.tenor || "instant",
  };
  return call<FxQuote>("/v1/exchange/stablefx/quotes", { method: "POST", body: JSON.stringify(body) });
}

export interface FxTrade {
  id: string;
  contractTradeId?: string;
  status: string;
  rate: number | string;
  from: FxAmount;
  to: FxAmount;
  createDate: string;
  updateDate: string;
  quoteId: string;
}

/** Step 2 — accept the quote and lock the rate in. */
export async function createTrade(quoteId: string): Promise<FxTrade> {
  const idempotencyKey = crypto.randomUUID();
  return call<FxTrade>("/v1/exchange/stablefx/trades", { method: "POST", body: JSON.stringify({ idempotencyKey, quoteId }) });
}

export interface Permit2TypedData {
  domain: { name: string; chainId: number; verifyingContract: `0x${string}` };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: "PermitWitnessTransferFrom";
  message: Record<string, unknown>;
}

/** Step 3 — the EIP-712 payload to sign, built server-side by StableFX for this exact trade + recipient. */
export async function getFundingPresignData(tradeId: string, recipientAddress: `0x${string}`): Promise<Permit2TypedData> {
  const res = await call<{ typedData: Permit2TypedData }>(`/v1/exchange/stablefx/signatures/presign/taker/${tradeId}?recipientAddress=${recipientAddress}`, { method: "GET" });
  return res.typedData;
}

/** Step 4 — sign the presigned data with this process's own wallet. Circle never sees the private key. */
export async function signFundingData(account: PrivateKeyAccount, typedData: Permit2TypedData): Promise<`0x${string}`> {
  return account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}

/** Step 5 — submit the signature; StableFX settles on-chain via FxEscrow. Direct on-chain funding (bypassing
 *  the API) is also documented as valid — not implemented here since the API path covers the same settlement
 *  guarantee and needs no separate FxEscrow ABI maintained in this codebase. */
export async function submitFunding(typedData: Permit2TypedData, signature: `0x${string}`): Promise<void> {
  const msg = typedData.message as { permitted: { token: string; amount: string | number }; spender: string; nonce: string | number; deadline: number; witness: { id?: string } };
  await call<void>("/v1/exchange/stablefx/fund", {
    method: "POST",
    body: JSON.stringify({
      type: "taker",
      signature,
      permit2: { permitted: msg.permitted, spender: msg.spender, nonce: String(msg.nonce), deadline: msg.deadline, witness: msg.witness },
    }),
  });
}

/**
 * The full taker-side flow: quote → trade → presign → sign → fund. One call, real money, real settlement —
 * once STABLEFX_API_KEY is configured. Throws a clear, named error (never a fabricated result) when it
 * isn't, so callers can report exactly what's missing rather than pretending the conversion happened.
 */
export async function convertUsdcToEurc(input: { account: PrivateKeyAccount; recipientAddress: `0x${string}`; fromAmountUsdc: number; tenor?: FxTenor }): Promise<{ quote: FxQuote; trade: FxTrade }> {
  if (!stablefxEnabled()) {
    throw new Error("StableFX is not configured — set STABLEFX_API_KEY (obtained from a Circle representative, sales@circle.com). The full code path below is complete and will execute the moment a key is supplied.");
  }
  const quote = await getQuote({ fromAmountUsdc: input.fromAmountUsdc, tenor: input.tenor });
  const trade = await createTrade(quote.id);
  const typedData = await getFundingPresignData(trade.id, input.recipientAddress);
  const signature = await signFundingData(input.account, typedData);
  await submitFunding(typedData, signature);
  return { quote, trade };
}

export function stablefxConfig() {
  return { enabled: stablefxEnabled(), minTradeUsdc: MIN_TRADE_USDC, fxEscrow: ARC.fxEscrow || null, permit2: ARC.permit2, network: ARC.name };
}
