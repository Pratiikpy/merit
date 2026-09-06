/**
 * Chain reconciliation — the /proof ledger checked against Arc itself.
 *
 * Everything Merit publishes about its own settlements is, until now, Merit's word: our ledger, our totals, our
 * receipts. The honesty claim deserves better than that. Arc emits a `Transfer` log for every USDC movement on
 * TWO independent emitters (EIP-7708) — the native system emitter at 18 decimals and the ERC-20 contract at 6 —
 * so a settlement can be re-derived from chain state and compared with what we said.
 *
 * Two directions, both necessary:
 *
 *  1. LEDGER → CHAIN. For every settlement row that carries a real tx hash, fetch the receipt and confirm a USDC
 *     transfer of the stated size actually happened, that both emitters agree, and that the transaction
 *     succeeded. This catches a row that overstates what moved.
 *
 *  2. CHAIN → LEDGER. Scan a bounded recent window of OUTBOUND transfers from the settlement wallet and flag any
 *     the ledger does not explain. This catches the opposite failure — money that left without a published
 *     receipt — which no amount of ledger-side checking can see.
 *
 * Arc's RPC caps `eth_getLogs` at 10,000 blocks per request (measured, ~86 minutes at ~0.52s per block), so
 * direction 2 is explicitly a WINDOW and every response states its bounds. A clean scan means "nothing
 * unexplained in this window", never "nothing unexplained ever".
 */
import { createPublicClient, getAddress, http, type Hex } from "viem";
import { ARC, explorerTx, round6 } from "./arc";
import { TRANSFER_EVENT, decodeTransferLogs } from "./memo";

const MAX_BLOCKS_PER_REQUEST = 10_000; // Arc RPC hard limit, confirmed empirically against rpc.testnet.arc.network
const AVG_BLOCK_SECONDS = 0.5162; // measured over 10,000 blocks on Arc testnet, 2026-09-06

function pub() {
  return createPublicClient({ transport: http(process.env.ARC_RPC_URL || ARC.rpcUrl) });
}

function sameAddr(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

export interface LedgerClaim {
  /** the receipt/card id this settlement was published under */
  id: string;
  tx: string;
  /** what Merit says was paid, in human USDC */
  usdc: number;
  /** the payee, when the ledger recorded one (optional — many rows only record the amount) */
  to?: string;
}

export interface RowReconciliation {
  /** the published row(s) this reconciliation covers — more than one when a batch settled several ledger
   *  lines to the same payee in a single transaction */
  id: string;
  ids: string[];
  tx: string;
  claimedUsdc: number;
  /** what the chain says moved in that transaction, summed over the ERC-20 emitter only */
  onchainUsdc: number | null;
  status: "match" | "mismatch" | "not-found" | "reverted" | "unreadable";
  /** true when the 18-decimal system log and the 6-decimal ERC-20 log tell the same story */
  emittersAgree: boolean | null;
  detail: string;
}

/**
 * Group published rows into the units the chain can actually distinguish: one (transaction, payee) pair.
 *
 * This matters because a BATCHED payout is one transaction carrying several ledger lines — and when those
 * lines go to the SAME wallet (a domain claiming the balances of its source plus each co-author split), the
 * chain shows one combined movement per line with no way to tell which line is which. Reconciling such rows
 * individually would report every one of them as a mismatch against the batch total, which is a reporting bug,
 * not a real discrepancy. Grouping compares like with like: the sum the ledger claims for that payee in that
 * transaction, against the sum the chain shows.
 */
export type GroupedClaim = LedgerClaim & { ids: string[] };

export function groupClaims(rows: LedgerClaim[]): GroupedClaim[] {
  const byKey = new Map<string, GroupedClaim>();
  const out: GroupedClaim[] = [];
  for (const r of rows) {
    const key = `${r.tx.toLowerCase()}|${(r.to || "").toLowerCase()}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.usdc = round6(cur.usdc + r.usdc);
      cur.ids.push(r.id);
    } else {
      const g = { ...r, usdc: round6(r.usdc), ids: [r.id] };
      byKey.set(key, g);
      out.push(g);
    }
  }
  return out;
}

/**
 * The pure decision, separated from the RPC I/O so every branch is unit-testable without a chain: given the
 * transfers a receipt actually contains, does it back what the ledger published?
 *
 * `claimedUsdc` matches when the ERC-20 transfers (restricted to the stated payee, when the ledger recorded
 * one) sum to it within 1e-6 — USDC's own smallest unit, so the tolerance cannot hide a real discrepancy. The
 * emitter cross-check is separate and never substitutes for it: 1 ERC-20 atomic unit is 1e12 system units, and
 * the two streams must agree exactly.
 */
export function decideRow(input: {
  claimedUsdc: number;
  transfers: Array<{ emitter: "system" | "erc20" | "other"; to: string; value: bigint; usdc: number }>;
  to?: string;
}): { onchainUsdc: number; match: boolean; emittersAgree: boolean; detail: string } {
  const wanted = (t: { to: string }) => (input.to ? sameAddr(t.to, input.to) : true);
  const erc20 = input.transfers.filter((t) => t.emitter === "erc20" && wanted(t));
  const system = input.transfers.filter((t) => t.emitter === "system" && wanted(t));
  const onchainUsdc = round6(erc20.reduce((s, t) => s + t.usdc, 0));
  const erc20Atomic = erc20.reduce((s, t) => s + t.value, BigInt(0));
  const systemAtomic = system.reduce((s, t) => s + t.value, BigInt(0));
  const emittersAgree = erc20.length > 0 && systemAtomic === erc20Atomic * BigInt(1e12);
  const match = Math.abs(onchainUsdc - round6(input.claimedUsdc)) <= 1e-6;
  return {
    onchainUsdc,
    match,
    emittersAgree,
    detail: match
      ? `chain confirms $${onchainUsdc}${emittersAgree ? " (both emitters agree)" : " (system-log cross-check unavailable)"}`
      : `ledger says $${round6(input.claimedUsdc)}, chain shows $${onchainUsdc}`,
  };
}

/** Verify ONE published settlement against its transaction on Arc. */
export async function reconcileRow(row: LedgerClaim & { ids?: string[] }): Promise<RowReconciliation> {
  const base = { id: row.id, ids: row.ids || [row.id], tx: row.tx, claimedUsdc: round6(row.usdc) };
  if (!/^0x[0-9a-fA-F]{64}$/.test(row.tx)) {
    return { ...base, onchainUsdc: null, status: "unreadable", emittersAgree: null, detail: "not a transaction hash (a Gateway batch transfer-id or an accrual)" };
  }
  let rc;
  try {
    rc = await pub().getTransactionReceipt({ hash: row.tx as Hex });
  } catch {
    return { ...base, onchainUsdc: null, status: "not-found", emittersAgree: null, detail: "no receipt for this hash on Arc" };
  }
  if (rc.status !== "success") {
    return { ...base, onchainUsdc: 0, status: "reverted", emittersAgree: null, detail: "the transaction reverted on-chain" };
  }
  const d = decideRow({ claimedUsdc: row.usdc, transfers: decodeTransferLogs(rc.logs), to: row.to });
  return { ...base, onchainUsdc: d.onchainUsdc, status: d.match ? "match" : "mismatch", emittersAgree: d.emittersAgree, detail: d.detail };
}

export interface OutflowScan {
  wallet: string;
  window: { fromBlock: number; toBlock: number; blocks: number; approxHours: number };
  /** every outbound ERC-20 USDC transfer from the wallet inside the window */
  outflows: Array<{ tx: string; to: string; usdc: number; block: number; explorerUrl: string; explained: boolean }>;
  totalUsdc: number;
  explainedUsdc: number;
  unexplainedUsdc: number;
  unexplained: number;
  truncated: boolean;
}

/**
 * Scan outbound USDC from the settlement wallet and mark each transfer explained or not against a set of tx
 * hashes the ledger published. Bounded by `blocks` (chunked to the RPC's 10,000-block limit) and by `maxChunks`,
 * and the window it actually covered is always reported — an unexplained count of 0 is only meaningful
 * alongside the window it was measured over.
 */
export async function scanOutflows(input: { wallet: string; knownTxs: Set<string>; blocks?: number; maxChunks?: number }): Promise<OutflowScan> {
  const client = pub();
  const maxChunks = Math.max(1, Math.min(24, input.maxChunks ?? 4));
  const want = Math.max(1, Math.min(MAX_BLOCKS_PER_REQUEST * maxChunks, input.blocks ?? MAX_BLOCKS_PER_REQUEST * 2));
  const head = await client.getBlockNumber();
  const from = head - BigInt(want) < BigInt(0) ? BigInt(0) : head - BigInt(want);

  const outflows: OutflowScan["outflows"] = [];
  let cursor = from;
  let chunks = 0;
  let truncated = false;
  while (cursor <= head) {
    if (chunks >= maxChunks) {
      truncated = true;
      break;
    }
    const end = cursor + BigInt(MAX_BLOCKS_PER_REQUEST) > head ? head : cursor + BigInt(MAX_BLOCKS_PER_REQUEST);
    const logs = await client.getLogs({
      address: ARC.usdc as `0x${string}`,
      event: TRANSFER_EVENT[0],
      args: { from: getAddress(input.wallet) },
      fromBlock: cursor,
      toBlock: end,
    });
    for (const l of logs) {
      const value = (l.args as { value?: bigint }).value ?? BigInt(0);
      const to = (l.args as { to?: string }).to || "";
      const tx = l.transactionHash || "";
      outflows.push({
        tx,
        to,
        usdc: round6(Number(value) / 1e6),
        block: Number(l.blockNumber ?? 0),
        explorerUrl: tx ? explorerTx(tx) : "",
        explained: input.knownTxs.has(tx.toLowerCase()),
      });
    }
    cursor = end + BigInt(1);
    chunks += 1;
  }

  const totalUsdc = round6(outflows.reduce((s, o) => s + o.usdc, 0));
  const explainedUsdc = round6(outflows.filter((o) => o.explained).reduce((s, o) => s + o.usdc, 0));
  const covered = Number(head - from);
  return {
    wallet: getAddress(input.wallet),
    window: { fromBlock: Number(from), toBlock: Number(head), blocks: covered, approxHours: round6((covered * AVG_BLOCK_SECONDS) / 3600) },
    outflows,
    totalUsdc,
    explainedUsdc,
    unexplainedUsdc: round6(totalUsdc - explainedUsdc),
    unexplained: outflows.filter((o) => !o.explained).length,
    truncated,
  };
}
