/**
 * Global verified payouts, part 1: pay a creator directly in EURC instead of USDC.
 *
 * EURC is a real, live, standard ERC-20 on Arc (lib/arc.ts `ARC.eurc`) — not a wrapped or bridged variant;
 * Circle issues it natively on Arc the same way it issues USDC there. The transfer itself reuses the exact
 * memo-wrapped payment primitive every other Merit payout uses (lib/memo.ts `sendMemoedTokenTransfer`), so a
 * EURC payout carries the same on-chain, independently-verifiable record of which verified work it settled.
 *
 * Merit's internal accounting is USD-denominated everywhere (price, escrow, balance, settlement) — that
 * doesn't change here. What changes is the LAST step: once a USDC amount is owed to a creator who prefers
 * EURC, it's converted at a real, live, independently-sourced rate (the ECB reference rate, published
 * free and keyless by the Frankfurter API) before sending. This is deliberately NOT StableFX's own quote —
 * that RFQ engine requires a Circle-issued API key Merit does not hold yet (see lib/stablefx.ts) — so the
 * rate source is named plainly in every payout record rather than presented as if it came from Circle.
 */
import { createPublicClient, http, parseAbi, getAddress } from "viem";
import type { PrivateKeyAccount } from "viem";
import { ARC, isStub, round6, arcChain } from "./arc";
import { sendMemoedTokenTransfer, buildPayoutMemo } from "./memo";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const transport = () => http(ARC.rpcUrl);
const pub = () => createPublicClient({ chain: arcChain(), transport: transport() });
const explorerTx = (h: string) => `${ARC.explorer}/tx/${h}`;

export function eurcAddress(): `0x${string}` | null {
  return ARC.eurc && /^0x[0-9a-fA-F]{40}$/.test(ARC.eurc) ? (ARC.eurc as `0x${string}`) : null;
}
export function eurcEnabled(): boolean {
  return !!eurcAddress() && !isStub();
}

export async function readEurcBalance(wallet: string): Promise<number | null> {
  const token = eurcAddress();
  if (!token) return null;
  try {
    const atomic = (await pub().readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [getAddress(wallet)] })) as bigint;
    return round6(Number(atomic) / 1e6); // EURC uses 6 decimals, same as USDC's ERC-20 interface
  } catch {
    return null;
  }
}

export interface FxRate {
  usdToEur: number;
  source: string;
  asOf: string;
}

let rateCache: { rate: FxRate; fetchedAt: number } | null = null;
const RATE_CACHE_MS = 5 * 60 * 1000;

/**
 * The live USD→EUR reference rate, from the European Central Bank's published rates via the free, keyless
 * Frankfurter API — a real, named, independent source, cached 5 minutes to avoid hammering it. Throws rather
 * than falling back to a guessed or stale-beyond-cache number: a payout that can't get a real rate should
 * fail cleanly, not send the wrong amount.
 */
export async function liveUsdToEurRate(): Promise<FxRate> {
  if (rateCache && Date.now() - rateCache.fetchedAt < RATE_CACHE_MS) return rateCache.rate;
  const res = await fetch("https://api.frankfurter.dev/v1/latest?from=USD&to=EUR", { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`FX rate fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { date: string; rates?: { EUR?: number } };
  const usdToEur = body.rates?.EUR;
  if (!usdToEur || !Number.isFinite(usdToEur)) throw new Error("FX rate response had no usable EUR rate");
  const rate: FxRate = { usdToEur, source: "ECB reference rate via Frankfurter (api.frankfurter.dev)", asOf: body.date };
  rateCache = { rate, fetchedAt: Date.now() };
  return rate;
}

export interface EurcPayout {
  id: string;
  sourceId: string;
  sourceName: string;
  wallet: string;
  usdcOwed: number;
  eurcSent: number;
  rate: FxRate;
  at: string;
  tx: { hash: string; explorerUrl: string } | null;
}
interface EurcLog {
  payouts: EurcPayout[];
}
const DOC = "eurc-payouts";
const MAX = 500;
let cache: EurcLog | null = null;
function load(): EurcLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<EurcLog>(DOC, { payouts: [] });
  if (!Array.isArray(value.payouts)) value.payouts = [];
  if (cacheable) cache = value;
  return value;
}
export async function refreshEurcFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<EurcLog>(DOC);
  if (v && Array.isArray(v.payouts)) cache = v;
}
function persist(log: EurcLog): void {
  cache = log;
  saveDoc(DOC, log);
}
function newId(): string {
  return Math.random().toString(36).slice(2, 13);
}

export function listEurcPayouts(limit = 40): EurcPayout[] {
  const p = load().payouts;
  return p.slice(Math.max(0, p.length - limit)).reverse();
}
export function eurcPayoutStats(): { count: number; usdcOwedTotal: number; eurcSentTotal: number } {
  const p = load().payouts;
  return {
    count: p.length,
    usdcOwedTotal: round6(p.reduce((s, x) => s + x.usdcOwed, 0)),
    eurcSentTotal: round6(p.reduce((s, x) => s + x.eurcSent, 0)),
  };
}

/**
 * Pay a USDC-denominated amount owed to a creator who prefers EURC: fetch the live rate, convert, send a
 * real memo-wrapped EURC transfer, and record both the USD amount owed and the actual EURC amount + rate
 * used, so the conversion is auditable after the fact, not just asserted.
 */
export async function payInEurc(input: { account: PrivateKeyAccount; sourceId: string; sourceName: string; wallet: `0x${string}`; usdcOwed: number }): Promise<{ payout: EurcPayout } | { error: string; status: number }> {
  const token = eurcAddress();
  if (!token) return { error: "EURC is not configured for this network (ARC_MAINNET_EURC unset)", status: 503 };
  const usdcOwed = round6(input.usdcOwed);
  if (usdcOwed <= 0) return { error: "nothing owed", status: 400 };

  let rate: FxRate;
  try {
    rate = await liveUsdToEurRate();
  } catch (e) {
    return { error: `could not fetch a live FX rate, refusing to guess: ${(e as Error).message.slice(0, 150)}`, status: 502 };
  }
  const eurcSent = round6(usdcOwed * rate.usdToEur);
  const atomic = BigInt(Math.round(eurcSent * 1e6));

  let tx: EurcPayout["tx"] = null;
  if (!isStub()) {
    try {
      const { memoId, memoData } = buildPayoutMemo({ kind: "eurc-payout", id: input.sourceId, amount: usdcOwed, refs: [], note: `${usdcOwed} USDC → ${eurcSent} EURC @ ${rate.usdToEur} (${rate.source}, ${rate.asOf})` });
      const result = await sendMemoedTokenTransfer({ account: input.account, token, to: input.wallet, atomic, memo: { memoId, memoData } });
      await pub().waitForTransactionReceipt({ hash: result.hash });
      tx = { hash: result.hash, explorerUrl: explorerTx(result.hash) };
    } catch (e) {
      return { error: `EURC transfer failed, nothing was recorded: ${(e as Error).message.slice(0, 200)}`, status: 502 };
    }
  }

  const payout: EurcPayout = {
    id: newId(),
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    wallet: input.wallet,
    usdcOwed,
    eurcSent,
    rate,
    at: new Date().toISOString(),
    tx,
  };
  const log = load();
  log.payouts.push(payout);
  if (log.payouts.length > MAX) log.payouts = log.payouts.slice(-MAX);
  persist(log);
  return { payout };
}
