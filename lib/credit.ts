/**
 * Agent credit — a cash advance against a source's PROVEN verification record, collateralized by its
 * real on-chain stake (contracts/src/Stake.sol, already deployed — Merit #15). The pattern mirrors
 * ARCANA's validated "performance → reputation → unlocked credit" ladder (live on Arc, trading agents,
 * ~110K decisions): here the "performance" is Merit's own merit score, a real signal already accrued
 * from real citation outcomes (lib/registry.ts `applyOutcome`), not a new metric invented for this.
 *
 * Deliberately built at the application layer on top of Stake.sol rather than as a new lending contract
 * — the same choice Insurance and PredictionMarket already made, and for the same reason: the primitive
 * that matters (real collateral, real slashing power) is already deployed, forge-tested, and source-
 * verified on both Arc networks. A dedicated on-chain credit contract is a legitimate next iteration,
 * not a requirement for this to be a real, complete feature today.
 *
 *   1. requestAdvance   eligibility = merit tier + real on-chain stake. The advance itself is a real,
 *                       memo-wrapped USDC transfer (kind: "credit-advance") from Merit's treasury to the
 *                       source's own wallet — not a ledger entry pretending to be a payment.
 *   2. repayAdvance     voluntary: the source sends USDC back and reports the tx hash; this VERIFIES that
 *                       transfer actually landed (to the treasury, from the source's own wallet, for at
 *                       least the claimed amount) before reducing the debt. Merit's architecture never
 *                       holds a source's private key (wallets are receive-only), so repayment can only
 *                       ever be the source's own action — there is no "pull" path, and none is faked here.
 *   3. resolveOverdueAdvance   operator-triggered: once the grace period has passed on unpaid debt, calls
 *                       Stake.sol's real slash() to recover up to the debt amount from the source's own
 *                       staked collateral — the actual enforcement mechanism, not a note that enforcement
 *                       "would" happen.
 */
import { createWalletClient, createPublicClient, http, parseAbi, keccak256, toHex, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { ARC, isStub, round6, arcChain } from "./arc";
import { serialize } from "./locks";
import { getSource } from "./registry";
import { buildPayoutMemo, sendMemoedTransfer } from "./memo";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

const STAKE_ABI = parseAbi([
  "function stakeOf(address) view returns (uint256)",
  "function slash(address source, uint256 amount, string reason)",
]);

function stakeAddress(): `0x${string}` | null {
  const a = process.env.STAKE_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : null;
}
function requireStakeAddress(): `0x${string}` {
  const a = stakeAddress();
  if (!a) throw new Error("STAKE_ADDRESS is not configured for this network");
  return a;
}

/** On-chain credit ops are active with the flag + the OPERATOR key (both the advance's funder and the
 *  slasher) + a configured Stake address for this network, not STUB. Mirrors every other *_ONCHAIN flag. */
export function creditOnchainEnabled(): boolean {
  return process.env.CREDIT_ONCHAIN === "1" && !!process.env.OPERATOR_PRIVATE_KEY && !!stakeAddress() && !isStub();
}

/** The absolute ceiling on any single source's outstanding credit, regardless of tier. This is a real-
 *  money proof of the mechanism, not a sized lending product. Override with MERIT_CREDIT_MAX_USDC. */
const MAX_CREDIT_USDC = Math.max(0.05, Number(process.env.MERIT_CREDIT_MAX_USDC) || 1);
/** How long unpaid debt is given before the operator may slash to recover it. Override (seconds) with
 *  MERIT_CREDIT_GRACE_SECONDS. */
const GRACE_SECONDS = Math.max(3600, Number(process.env.MERIT_CREDIT_GRACE_SECONDS) || 7 * 24 * 3600);

const transport = () => http(ARC.rpcUrl);
const pub = () => createPublicClient({ chain: arcChain(), transport: transport() });
function operator() {
  const account = privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
  return { account, wallet: createWalletClient({ account, chain: arcChain(), transport: transport() }) };
}
const explorerTx = (h: string) => `${ARC.explorer}/tx/${h}`;

/**
 * The tier ladder: ARCANA's validated shape (performance unlocks a MULTIPLE of posted collateral, not a
 * flat amount) applied to Merit's own reputation signal. A source under 50 merit has no proven record
 * yet and gets no credit at any stake size — matching Stake.sol's own framing of stake as "skin in the
 * game behind its reputation," not a substitute for one.
 */
export function creditTierMultiple(merit: number): number {
  if (merit >= 90) return 2;
  if (merit >= 70) return 1;
  if (merit >= 50) return 0.5;
  return 0;
}

/** The credit limit a source currently qualifies for: real stake × its merit tier, capped globally.
 *  Pure — takes the already-read stake rather than reading the chain itself, so it's directly testable. */
export function creditLimitFor(merit: number, stakeUsdc: number): number {
  const limit = round6(stakeUsdc * creditTierMultiple(merit));
  return Math.min(limit, MAX_CREDIT_USDC);
}

/** Read a source's real on-chain stake (USDC, human units). Null off-chain/unconfigured. */
export async function readStake(wallet: string): Promise<number | null> {
  if (!stakeAddress()) return null;
  try {
    const atomic = (await pub().readContract({ address: requireStakeAddress(), abi: STAKE_ABI, functionName: "stakeOf", args: [getAddress(wallet)] })) as bigint;
    return round6(Number(atomic) / 1e6);
  } catch {
    return null;
  }
}

export interface CreditAdvance {
  id: string;
  sourceId: string;
  sourceName: string;
  wallet: string;
  meritAtIssue: number;
  stakeAtIssue: number | null;
  limitAtIssue: number;
  amountUsdc: number;
  repaidUsdc: number;
  status: "outstanding" | "repaid" | "slashed";
  issuedAt: string;
  dueAt: string; // issuedAt + GRACE_SECONDS — when resolveOverdueAdvance may slash
  resolvedAt?: string;
  txs: Array<{ step: string; hash: string; explorerUrl: string }>;
}
interface CreditLog {
  advances: CreditAdvance[];
}

const DOC = "credit";
const MAX = 500;
let cache: CreditLog | null = null;
function load(): CreditLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<CreditLog>(DOC, { advances: [] });
  if (!Array.isArray(value.advances)) value.advances = [];
  if (cacheable) cache = value;
  return value;
}
export async function refreshCreditFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<CreditLog>(DOC);
  if (v && Array.isArray(v.advances)) cache = v;
}
function persist(log: CreditLog): void {
  cache = log;
  saveDoc(DOC, log);
}
function newId(): string {
  return BigInt("0x" + randomBytes(8).toString("hex")).toString(36).slice(0, 11);
}

export function getAdvance(id: string): CreditAdvance | undefined {
  return load().advances.find((a) => a.id === id);
}
export function listAdvances(limit = 40): CreditAdvance[] {
  const a = load().advances;
  return a.slice(Math.max(0, a.length - limit)).reverse();
}
/** A source's current outstanding debt, summed across every advance that isn't fully repaid/slashed. */
export function outstandingDebt(sourceId: string): number {
  return round6(
    load()
      .advances.filter((a) => a.sourceId === sourceId && a.status === "outstanding")
      .reduce((s, a) => s + (a.amountUsdc - a.repaidUsdc), 0),
  );
}
export function creditStats(): { total: number; outstanding: number; outstandingUsdc: number; repaidUsdc: number; slashedUsdc: number } {
  const a = load().advances;
  return {
    total: a.length,
    outstanding: a.filter((x) => x.status === "outstanding").length,
    outstandingUsdc: round6(a.filter((x) => x.status === "outstanding").reduce((s, x) => s + (x.amountUsdc - x.repaidUsdc), 0)),
    repaidUsdc: round6(a.reduce((s, x) => s + x.repaidUsdc, 0)),
    slashedUsdc: round6(a.filter((x) => x.status === "slashed").reduce((s, x) => s + (x.amountUsdc - x.repaidUsdc), 0)),
  };
}

export interface RequestAdvanceInput {
  sourceId: string;
  amountUsdc: number;
}

/** Issue a real cash advance: checks the source's merit tier against its REAL on-chain stake, checks the
 *  request against remaining credit (limit minus existing debt), and — when on-chain is enabled — sends
 *  a real memo-wrapped USDC transfer from the OPERATOR treasury to the source's own wallet. */
export async function requestAdvance(input: RequestAdvanceInput): Promise<{ advance: CreditAdvance } | { error: string; status: number }> {
  const amountUsdc = round6(Number(input.amountUsdc) || 0);
  if (amountUsdc <= 0) return { error: "amountUsdc must be > 0", status: 400 };
  const source = getSource(input.sourceId);
  if (!source) return { error: "unknown source", status: 404 };
  if (source.custodial) return { error: "a custodial (wallet-less) source has nowhere for an advance to land — it must prove a wallet first", status: 400 };

  const stakeUsdc = await readStake(source.wallet);
  if (stakeUsdc === null) return { error: "could not read the source's on-chain stake (STAKE_ADDRESS unconfigured or RPC unavailable)", status: 502 };
  const limit = creditLimitFor(source.merit, stakeUsdc);
  const debt = outstandingDebt(source.id);
  if (limit <= 0) return { error: `merit ${source.merit} is below the minimum tier (50) for any credit, regardless of stake`, status: 403 };
  if (round6(debt + amountUsdc) > limit) {
    return { error: `requested $${amountUsdc} + existing debt $${debt} would exceed this source's $${limit} limit (merit ${source.merit} × stake $${stakeUsdc})`, status: 403 };
  }

  const now = Date.now();
  const advance: CreditAdvance = {
    id: newId(),
    sourceId: source.id,
    sourceName: source.name,
    wallet: source.wallet,
    meritAtIssue: source.merit,
    stakeAtIssue: stakeUsdc,
    limitAtIssue: limit,
    amountUsdc,
    repaidUsdc: 0,
    status: "outstanding",
    issuedAt: new Date(now).toISOString(),
    dueAt: new Date(now + GRACE_SECONDS * 1000).toISOString(),
    txs: [],
  };

  if (creditOnchainEnabled()) {
    try {
      const op = operator();
      const atomic = BigInt(Math.round(amountUsdc * 1e6));
      const { memoId, memoData } = buildPayoutMemo({
        kind: "credit-advance",
        id: source.id,
        amount: amountUsdc,
        refs: [],
        note: `advance against merit=${source.merit}, stake=$${stakeUsdc}, limit=$${limit}`,
      });
      const result = await serialize("operator", () =>
        sendMemoedTransfer({ account: op.account, to: getAddress(source.wallet) as `0x${string}`, atomic, memo: { memoId, memoData } }),
      );
      await pub().waitForTransactionReceipt({ hash: result.hash });
      advance.txs.push({ step: "advance", hash: result.hash, explorerUrl: explorerTx(result.hash) });
    } catch (e) {
      return { error: `on-chain advance failed, nothing was recorded: ${(e as Error).message.slice(0, 200)}`, status: 502 };
    }
  }

  const log = load();
  log.advances.push(advance);
  if (log.advances.length > MAX) log.advances = log.advances.slice(-MAX);
  persist(log);
  return { advance };
}

export interface RepayAdvanceInput {
  advanceId: string;
  amountUsdc: number;
  txHash: string;
}

/**
 * Voluntary repayment. Merit never holds a source's key (wallets are receive-only throughout this
 * codebase), so this can only ever be the source's own action — verified by reading the claimed
 * transaction from the chain and checking it actually moved at least `amountUsdc` FROM the source's own
 * wallet TO the operator's treasury. A tx that doesn't match is refused, not trusted.
 */
export async function repayAdvance(input: RepayAdvanceInput): Promise<{ advance: CreditAdvance } | { error: string; status: number }> {
  const advance = getAdvance(input.advanceId);
  if (!advance) return { error: "advance not found", status: 404 };
  if (advance.status !== "outstanding") return { error: `advance already ${advance.status}`, status: 409 };
  const amountUsdc = round6(Number(input.amountUsdc) || 0);
  if (amountUsdc <= 0) return { error: "amountUsdc must be > 0", status: 400 };
  const txHash = (input.txHash || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { error: "provide a real transaction hash", status: 400 };

  if (!isStub()) {
    try {
      const rc = await pub().getTransactionReceipt({ hash: txHash as `0x${string}` });
      if (rc.status !== "success") return { error: "that transaction did not succeed on-chain", status: 400 };
      const transferSig = keccak256(toHex("Transfer(address,address,uint256)"));
      const operatorAddr = (process.env.OPERATOR_ADDRESS || "").toLowerCase();
      const sourceAddr = advance.wallet.toLowerCase();
      let moved = BigInt(0);
      for (const l of rc.logs) {
        if (l.address.toLowerCase() !== ARC.usdc.toLowerCase()) continue;
        if (l.topics[0] !== transferSig) continue;
        const from = `0x${(l.topics[1] || "").slice(-40)}`.toLowerCase();
        const to = `0x${(l.topics[2] || "").slice(-40)}`.toLowerCase();
        if (from === sourceAddr && to === operatorAddr) moved += BigInt(l.data);
      }
      const movedUsdc = round6(Number(moved) / 1e6);
      if (movedUsdc < amountUsdc) {
        return { error: `that transaction moved $${movedUsdc} USDC from ${advance.wallet} to the treasury, not the claimed $${amountUsdc}`, status: 400 };
      }
    } catch (e) {
      return { error: `could not verify that transaction on-chain: ${(e as Error).message.slice(0, 150)}`, status: 502 };
    }
  }

  const remaining = round6(advance.amountUsdc - advance.repaidUsdc);
  const applied = Math.min(amountUsdc, remaining);
  advance.repaidUsdc = round6(advance.repaidUsdc + applied);
  advance.txs.push({ step: "repayment", hash: txHash, explorerUrl: explorerTx(txHash) });
  if (advance.repaidUsdc >= advance.amountUsdc) {
    advance.status = "repaid";
    advance.resolvedAt = new Date().toISOString();
  }
  persist(load());
  return { advance };
}

/** Operator-only: once an advance's grace period has passed with debt still outstanding, slash the
 *  source's real on-chain stake to recover up to the unpaid amount. Real enforcement, not a note that
 *  it "would" happen — the same Stake.sol slash() every other mis-citation penalty already uses. */
export async function resolveOverdueAdvance(advanceId: string): Promise<{ advance: CreditAdvance } | { error: string; status: number }> {
  const advance = getAdvance(advanceId);
  if (!advance) return { error: "advance not found", status: 404 };
  if (advance.status !== "outstanding") return { error: `advance already ${advance.status}`, status: 409 };
  if (new Date(advance.dueAt).getTime() > Date.now()) {
    return { error: `grace period has not elapsed yet (due ${advance.dueAt})`, status: 409 };
  }
  const owed = round6(advance.amountUsdc - advance.repaidUsdc);
  if (owed <= 0) {
    advance.status = "repaid";
    advance.resolvedAt = new Date().toISOString();
    persist(load());
    return { advance };
  }
  if (!creditOnchainEnabled()) return { error: "on-chain credit is not enabled on this deployment — cannot slash without it", status: 409 };

  try {
    const op = operator();
    const atomic = BigInt(Math.round(owed * 1e6));
    const slashHash = await serialize("operator", () =>
      op.wallet.writeContract({
        address: requireStakeAddress(),
        abi: STAKE_ABI,
        functionName: "slash",
        args: [getAddress(advance.wallet), atomic, `overdue credit advance ${advance.id}`],
        account: op.account,
        chain: arcChain(),
      }),
    );
    await pub().waitForTransactionReceipt({ hash: slashHash });
    advance.txs.push({ step: "slash", hash: slashHash, explorerUrl: explorerTx(slashHash) });
    advance.repaidUsdc = advance.amountUsdc; // recovered via slash, not cash repayment — debt is settled either way
    advance.status = "slashed";
    advance.resolvedAt = new Date().toISOString();
    persist(load());
    return { advance };
  } catch (e) {
    return { error: `slash failed: ${(e as Error).message.slice(0, 200)}`, status: 502 };
  }
}
