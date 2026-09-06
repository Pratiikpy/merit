/**
 * Verification-resolved prediction market (Hub feature #7) — the only prediction market whose resolution is
 * deterministic GROUND TRUTH, not a human committee.
 *
 * A market asks "will this claim verify?" Traders stake USDC on YES/NO into a pari-mutuel pool (the deployed
 * PredictionMarket.sol — solvent by construction, winners split the whole pool). When it resolves, the ORACLE
 * is Merit's own three-gate verifier: it runs verifyCitation(claim, source) and calls resolve(marketId,
 * SUPPORTED) on-chain. No other market has a machine oracle — they settle on a human vote, a UMA dispute, or an
 * off-chain feed. Here the oracle IS the settlement layer, so the market both surfaces a live crowd-probability
 * the verifier could read as a prior AND settles itself the instant the claim is checked.
 *
 * On-chain against the deployed contract (oracle = Merit's OPERATOR wallet); gated by MARKET_ONCHAIN=1 + keys +
 * !stub, else the market still resolves at the app level by the same verdict. Honesty: an on-chain tx/link is
 * recorded only when it actually lands; the resolution always carries the signed verificationId that decided it.
 */
import { createWalletClient, createPublicClient, http, parseAbi, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { ARC, isStub, round6, arcChain } from "./arc";
import { serialize } from "./locks";
import { verifyCitation, isVerifyError } from "./verify/engine";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

const MARKET_ABI = parseAbi([
  "function stake(bytes32 marketId, bool yes, uint256 amount)",
  "function resolve(bytes32 marketId, bool yesWon)",
  "function redeem(bytes32 marketId)",
  "function yesProbabilityBps(bytes32 marketId) view returns (uint256)",
  "function markets(bytes32) view returns (uint256 yesPool, uint256 noPool, uint8 outcome)",
]);
const USDC_APPROVE = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const DEPLOYED_MARKET = "0xb67C595d1F13E01fFF1a5690B938A249fE1eEE6e"; // contracts/deployments.json (oracle = OPERATOR)
function marketAddress(): `0x${string}` {
  const a = process.env.PREDICTION_MARKET_ADDRESS;
  return (a && /^0x[0-9a-fA-F]{40}$/.test(a) ? a : DEPLOYED_MARKET) as `0x${string}`;
}

/** On-chain market ops are active with the flag + BOTH staker (BUYER) and oracle (OPERATOR) keys, not STUB. */
export function marketOnchainEnabled(): boolean {
  return (
    process.env.MARKET_ONCHAIN === "1" &&
    !!process.env.BUYER_PRIVATE_KEY &&
    !!process.env.OPERATOR_PRIVATE_KEY &&
    !isStub()
  );
}

const transport = () => http(ARC.rpcUrl);
const pub = () => createPublicClient({ chain: arcChain(), transport: transport() });
function signer(envKey: string) {
  const account = privateKeyToAccount(process.env[envKey] as `0x${string}`);
  return { account, wallet: createWalletClient({ account, chain: arcChain(), transport: transport() }) };
}

export interface Market {
  id: string; // short public id
  marketId: `0x${string}`; // the on-chain bytes32 key
  claim: string;
  source?: string; // INTERNAL: the full source the oracle resolves against — stripped from API reads (preview only)
  sourcePreview: string;
  sourceHash: `0x${string}`;
  status: "open" | "resolved";
  yesBps: number; // live crowd probability the claim verifies (0..10000); 5000 = 50/50 / empty
  seedSide?: "yes" | "no"; // the side Merit seeded on-chain (if any)
  seedUsdc?: number;
  outcome?: "YES" | "NO"; // resolved: did the claim verify?
  verificationId?: string; // the signed verdict that resolved it
  reason?: string;
  txs?: Array<{ step: string; hash: string; explorerUrl: string }>;
  createdAt: string;
  resolvedAt?: string;
}
interface MarketLog {
  markets: Market[];
}

const DOC = "markets";
const MAX = 500;
let cache: MarketLog | null = null;
function load(): MarketLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<MarketLog>(DOC, { markets: [] });
  if (!value.markets) value.markets = [];
  if (cacheable) cache = value;
  return value;
}
export async function refreshMarketsFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<MarketLog>(DOC);
  if (v && Array.isArray(v.markets)) cache = v;
}
function persist(log: MarketLog): void {
  cache = log;
  saveDoc(DOC, log);
}
function newId(): string {
  return BigInt("0x" + randomBytes(8).toString("hex")).toString(36).slice(0, 11);
}

/** Strip the full source from a market before it leaves the module — API reads expose only the preview. */
function sanitize(m: Market): Market {
  const { source: _s, ...rest } = m;
  return rest;
}
/** Internal: the stored market WITH its full source (for resolution). */
function rawMarket(id: string): Market | undefined {
  return id ? load().markets.find((m) => m.id === id) : undefined;
}

export function getMarket(id: string): Market | undefined {
  const m = rawMarket(id);
  return m ? sanitize(m) : undefined;
}
export function listMarkets(limit = 40): Market[] {
  const m = load().markets;
  return m.slice(Math.max(0, m.length - limit)).reverse().map(sanitize);
}
export function marketStats(): { total: number; open: number; resolved: number; verifiedYes: number } {
  const m = load().markets;
  return {
    total: m.length,
    open: m.filter((x) => x.status === "open").length,
    resolved: m.filter((x) => x.status === "resolved").length,
    verifiedYes: m.filter((x) => x.outcome === "YES").length,
  };
}

const explorerTx = (h: string) => `${ARC.explorer}/tx/${h}`;

/** Read the live on-chain crowd probability (bps) for a market, or null off-chain. */
async function readYesBps(marketId: `0x${string}`): Promise<number | null> {
  if (!marketOnchainEnabled()) return null;
  try {
    const bps = (await pub().readContract({ address: marketAddress(), abi: MARKET_ABI, functionName: "yesProbabilityBps", args: [marketId] })) as bigint;
    return Number(bps);
  } catch {
    return null;
  }
}

export interface CreateMarketInput {
  claim: string;
  source: string;
  /** Optionally seed a real on-chain directional stake from Merit's wallet (so the pool + probability are real). */
  seedSide?: "yes" | "no";
  seedUsdc?: number;
}

/** Create a market on "will this claim verify?" Optionally seed a real on-chain stake so the pari-mutuel pool
 *  exists on-chain. Returns the market or a typed error. */
export async function createMarket(input: CreateMarketInput): Promise<{ market: Market } | { error: string; status: number }> {
  const claim = (input.claim || "").trim();
  const source = (input.source || "").trim();
  if (!claim || !source) return { error: "provide { claim, source } — the claim to make a market on and the source it will be checked against", status: 400 };
  if (claim.length > 4000 || source.length > 20000) return { error: "claim ≤ 4000, source ≤ 20000 chars", status: 400 };

  const sourceHash = keccak256(toHex(source));
  // Unique on-chain key per market (salted) so re-listing the same claim doesn't collide with a prior market.
  const marketId = keccak256(toHex(`merit:market:${claim}:${sourceHash}:${randomBytes(8).toString("hex")}`));
  const seedUsdc = Math.min(0.1, Math.max(0, round6(Number(input.seedUsdc) || 0)));
  const seedSide = input.seedSide === "no" ? "no" : input.seedSide === "yes" ? "yes" : undefined;

  const market: Market = {
    id: newId(),
    marketId,
    claim,
    source, // full text (internal) — the oracle resolves against this; stripped from API reads
    sourcePreview: source.slice(0, 600),
    sourceHash,
    status: "open",
    yesBps: 5000,
    createdAt: new Date().toISOString(),
    txs: [],
  };

  // Optional on-chain seed: stake real USDC on a side so the pool (and yesProbabilityBps) are real.
  if (seedSide && seedUsdc > 0 && marketOnchainEnabled()) {
    try {
      const buyer = signer("BUYER_PRIVATE_KEY");
      const atomic = BigInt(Math.round(seedUsdc * 1e6));
      const approveHash = await serialize("buyer", () =>
        buyer.wallet.writeContract({ address: ARC.usdc as `0x${string}`, abi: USDC_APPROVE, functionName: "approve", args: [marketAddress(), atomic], account: buyer.account, chain: arcChain() }),
      );
      await pub().waitForTransactionReceipt({ hash: approveHash });
      const stakeHash = await serialize("buyer", () =>
        buyer.wallet.writeContract({ address: marketAddress(), abi: MARKET_ABI, functionName: "stake", args: [marketId, seedSide === "yes", atomic], account: buyer.account, chain: arcChain() }),
      );
      await pub().waitForTransactionReceipt({ hash: stakeHash });
      market.seedSide = seedSide;
      market.seedUsdc = seedUsdc;
      market.txs!.push({ step: `stake(${seedSide})`, hash: stakeHash, explorerUrl: explorerTx(stakeHash) });
      const bps = await readYesBps(marketId);
      if (bps !== null) market.yesBps = bps;
    } catch (e) {
      console.error("[market] on-chain seed failed (market still created off-chain):", (e as Error).message);
    }
  }

  const log = load();
  log.markets.push(market);
  if (log.markets.length > MAX) log.markets = log.markets.slice(-MAX);
  persist(log);
  return { market: sanitize(market) };
}

/**
 * Resolve a market by GROUND TRUTH: run Merit's verifier on (claim, source); YES iff it verifies. When on-chain
 * is enabled, the OPERATOR (the contract's oracle) calls resolve(marketId, yesWon), and Merit redeems any seeded
 * stake on the winning side — a real pari-mutuel settlement gated by proof-of-citation. Never throws.
 */
export async function resolveMarket(id: string): Promise<{ market: Market } | { error: string; status: number }> {
  const market = rawMarket(id);
  if (!market) return { error: "market not found", status: 404 };
  if (market.status !== "open") return { error: "market already resolved", status: 409 };

  // The oracle: Merit's three-gate verifier, run against the FULL source the market was created with.
  const outcome = await verifyCitation(market.claim, market.source || market.sourcePreview, {});
  if (isVerifyError(outcome)) return { error: `oracle could not resolve: ${outcome.error}`, status: outcome.status };
  const verdict = outcome.verdict;
  const yesWon = verdict.verdict === "SUPPORTED";

  market.outcome = yesWon ? "YES" : "NO";
  market.verificationId = verdict.verificationId;
  market.reason = verdict.reason;
  market.status = "resolved";
  market.resolvedAt = new Date().toISOString();

  if (marketOnchainEnabled()) {
    try {
      const oracle = signer("OPERATOR_PRIVATE_KEY");
      const resolveHash = await serialize("operator", () =>
        oracle.wallet.writeContract({ address: marketAddress(), abi: MARKET_ABI, functionName: "resolve", args: [market.marketId, yesWon], account: oracle.account, chain: arcChain() }),
      );
      await pub().waitForTransactionReceipt({ hash: resolveHash });
      market.txs = market.txs || [];
      market.txs.push({ step: `resolve(${market.outcome})`, hash: resolveHash, explorerUrl: explorerTx(resolveHash) });

      // Redeem Merit's seeded stake if it landed on the winning side (real USDC back — proves the payout path).
      if (market.seedSide && ((market.seedSide === "yes") === yesWon)) {
        try {
          const buyer = signer("BUYER_PRIVATE_KEY");
          const redeemHash = await serialize("buyer", () =>
            buyer.wallet.writeContract({ address: marketAddress(), abi: MARKET_ABI, functionName: "redeem", args: [market.marketId], account: buyer.account, chain: arcChain() }),
          );
          await pub().waitForTransactionReceipt({ hash: redeemHash });
          market.txs.push({ step: "redeem(winnings)", hash: redeemHash, explorerUrl: explorerTx(redeemHash) });
        } catch (e) {
          console.error("[market] redeem failed (resolution still on-chain):", (e as Error).message);
        }
      }
    } catch (e) {
      console.error("[market] on-chain resolve failed (resolved at app level by the same verdict):", (e as Error).message);
    }
  }

  persist(load());
  return { market: sanitize(market) };
}
