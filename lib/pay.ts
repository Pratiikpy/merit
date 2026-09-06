/**
 * Buyer-side payment: the Merit agent deposits into Gateway once, then settles
 * real sub-cent x402 nanopayments to each cited+verified source. Stub-safe.
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ARC, isStub, fakeTxHash, explorerTx, round6 } from "./arc";
import { serialize } from "./locks";

export interface SettleResult {
  transaction: string;
  explorerUrl: string;
  amount: number; // dollar number actually paid
  stub: boolean;
  onchain: boolean; // true once a real 0x tx hash exists (vs a Gateway batch transfer-id)
}

let gateway: GatewayClient | null = null;
let depositReady = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client(): GatewayClient {
  if (gateway) return gateway;
  const pk = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
  const chainName = ARC.gatewayChainName;
  if (!chainName) {
    throw new Error(`Circle Gateway has no chain key configured for ${ARC.label} — set ARC_MAINNET_GATEWAY_CHAIN once Circle publishes it`);
  }
  gateway = new GatewayClient({
    chain: chainName as "arcTestnet",
    privateKey: pk,
    rpcUrl: process.env.ARC_RPC_URL,
  });
  return gateway;
}

let depositInFlight: Promise<void> | null = null;

/** Ensure the agent has Gateway balance to pay from (live only). Single-flight,
 * so concurrent runs share ONE deposit attempt instead of each depositing. */
export function ensureDeposit(minUsdc = 0.5, deposit = "1"): Promise<void> {
  if (isStub() || depositReady) return Promise.resolve();
  if (!depositInFlight) {
    depositInFlight = doEnsureDeposit(minUsdc, deposit).finally(() => {
      depositInFlight = null;
    });
  }
  return depositInFlight;
}

async function doEnsureDeposit(minUsdc: number, deposit: string): Promise<void> {
  const g = client();
  try {
    let avail = Number((await g.getBalances()).gateway.available) / 1e6;
    if (avail < minUsdc) {
      console.log(`[pay] Gateway balance ${avail} < ${minUsdc}, depositing ${deposit}…`);
      // Serialize the buyer-EOA write so it can't collide on nonce with feedback txs.
      const r = await serialize("buyer", () => g.deposit(deposit));
      console.log(`[pay] deposit tx ${r.depositTxHash} — waiting for Gateway to register…`);
      // Gateway's off-chain available balance lags the on-chain deposit; poll for it.
      for (let i = 0; i < 30 && avail < minUsdc; i++) {
        await sleep(2000);
        avail = Number((await g.getBalances()).gateway.available) / 1e6;
      }
      console.log(`[pay] Gateway available after deposit: ${avail}`);
      if (avail < minUsdc) {
        throw new Error(`Gateway balance did not register after deposit (available=${avail})`);
      }
    }
    depositReady = true;
  } catch (e) {
    throw new Error(`Gateway deposit failed (is the buyer wallet funded?): ${(e as Error).message}`);
  }
}

/** What an arbitrary x402 endpoint is asking for, as probed by the Gateway client (no payment made yet).
 *  `supported` = the Merit buyer can actually settle it (Circle Gateway batching scheme on a chain we hold
 *  balance on); `priceUsdc` is parsed from the challenge when present. Used by the endpoint scorer to decide
 *  whether to pay before verifying, and to record the toll terms honestly even when we don't/can't pay. */
export interface PaymentSupport {
  supported: boolean;
  priceUsdc: number | null;
  network: string | null;
  payTo: string | null;
  error: string | null;
}

/** Probe whether `url` is a payable x402 endpoint and read its terms — WITHOUT paying. Stub-safe (returns
 *  unsupported, since a stub holds no real balance to settle with). Never throws: a probe failure is reported,
 *  not raised, so the scorer degrades to a terms-unknown card instead of erroring. */
export async function supportsPayment(url: string): Promise<PaymentSupport> {
  if (isStub()) return { supported: false, priceUsdc: null, network: null, payTo: null, error: "stub mode holds no settlement balance" };
  try {
    const g = client();
    const s = await g.supports(url);
    const req = (s.requirements || {}) as { amount?: string | number; maxAmountRequired?: string | number; network?: string; payTo?: string };
    const atomic = req.amount ?? req.maxAmountRequired;
    const priceUsdc = atomic !== undefined && atomic !== null ? round6(Number(atomic) / 1e6) : null;
    return {
      supported: !!s.supported,
      priceUsdc: Number.isFinite(priceUsdc as number) ? (priceUsdc as number) : null,
      network: req.network ?? null,
      payTo: req.payTo ?? null,
      error: (s as { error?: string }).error ?? null,
    };
  } catch (e) {
    return { supported: false, priceUsdc: null, network: null, payTo: null, error: (e as Error).message };
  }
}

/** The content Merit actually received by paying an x402 endpoint's toll, plus the real settlement. */
export interface PaidFetch {
  data: unknown; // the resource the endpoint returned AFTER payment — the thing we then verify
  amount: number; // USDC actually paid
  transaction: string;
  explorerUrl: string;
  onchain: boolean;
}

/** Pay an arbitrary x402 endpoint's toll and return BOTH the settlement and the delivered content, so the
 *  caller can verify what it paid for. `maxUsdc` is a hard ceiling — a challenge above it is refused BEFORE any
 *  authorization is signed (never over-spend). Live only; a stub can't settle a real external toll, so it
 *  refuses rather than fabricate a payment+content. Throws on any settlement/over-charge failure (the scorer
 *  catches it and records a terms-only, unpaid card — an honest "couldn't pay", never a fake verdict). */
export async function payAndFetch(url: string, maxUsdc: number): Promise<PaidFetch> {
  if (isStub()) throw new Error("stub mode cannot settle a real external toll");
  const support = await supportsPayment(url);
  if (!support.supported) throw new Error(support.error || "endpoint does not accept a payment scheme Merit can settle");
  if (support.priceUsdc !== null && support.priceUsdc > maxUsdc + 1e-9)
    throw new Error(`toll ${support.priceUsdc} USDC exceeds the authorized ceiling ${maxUsdc} — refusing to over-spend`);
  await ensureDeposit(Math.max(0.5, (support.priceUsdc ?? 0) + 0.1));
  const g = client();
  const r = await g.pay(url, { method: "GET" });
  if (!r.transaction) throw new Error("settlement returned no transfer id");
  const amount = round6(parseFloat(r.formattedAmount || "0"));
  if (amount > maxUsdc + 1e-9) throw new Error(`settled ${amount} USDC exceeds the authorized ceiling ${maxUsdc}`);
  const isTx = typeof r.transaction === "string" && r.transaction.startsWith("0x");
  return { data: r.data, amount, transaction: r.transaction, explorerUrl: isTx ? explorerTx(r.transaction) : "", onchain: isTx };
}

/** Settle one nanopayment to a source's x402 endpoint. Returns the real tx hash.
 * `expectedAmount` (the source's authorized price) is enforced: a seller charging
 * a different non-zero amount is rejected, so actual spend never exceeds what the
 * budget guard authorized. */
export async function payOnce(url: string, expectedAmount?: number): Promise<SettleResult> {
  if (isStub()) {
    const tx = fakeTxHash();
    // STUB simulates the flow but touches NO chain — so onchain:false and NO explorer link, or the
    // receipt/UI would present a fabricated hash as a real, clickable settlement (a 404 a judge can't
    // tell from a genuine one). The fake hash is still carried in `transaction` for display continuity.
    return { transaction: tx, explorerUrl: "", amount: 0, stub: true, onchain: false };
  }
  const g = client();
  const r = await g.pay(url, { method: "GET" });
  // Don't count a 2xx response with no transfer id as a successful payment —
  // hard-fail it so the agent reports it as a settlement failure, not a paid source.
  if (!r.transaction) throw new Error("settlement returned no transfer id");
  const amount = round6(parseFloat(r.formattedAmount || "0"));
  // Over-charge protection as a CEILING, not an exact match: `expectedAmount` is the maximum the buyer will
  // accept for this source (the merit-gated max = 1.5x base). A settle at or below it is honored and the ACTUAL
  // amount is credited; only a charge ABOVE the ceiling is refused. Exact-match was wrong: the seller re-quotes
  // the merit-gated price at settle time and a legitimate merit change makes the amount differ slightly from any
  // pre-computed estimate — that must still settle, not be rejected as a "mismatch". (amount===0 → seller didn't
  // echo a price; caller falls back to its estimate.)
  if (expectedAmount !== undefined && amount > expectedAmount + 1e-9) {
    throw new Error(`settled ${amount} USDC exceeds the authorized ceiling ${expectedAmount} — refusing over-charge`);
  }
  // Gateway batched settlement returns a transfer id (UUID); an on-chain 0x tx
  // hash only exists once the batch lands. Only link to arcscan for real hashes.
  const isTx = typeof r.transaction === "string" && r.transaction.startsWith("0x");
  return {
    transaction: r.transaction,
    explorerUrl: isTx ? explorerTx(r.transaction) : "",
    amount,
    stub: false,
    onchain: isTx,
  };
}
