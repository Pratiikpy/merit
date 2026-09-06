import { NextResponse } from "next/server";
import { ARC, round6 } from "@/lib/arc";
import { listCards, refreshCardsFromMirror } from "@/lib/cards";
import { allCustodyPayouts, custodyAddress, refreshCustodyFromMirror } from "@/lib/custody";
import { allBalanceWithdrawals, refreshBalanceFromMirror } from "@/lib/balance";
import { groupClaims, reconcileRow, scanOutflows, type LedgerClaim, type RowReconciliation } from "@/lib/reconcile";
import { ephemeralStore, hydrateDoc } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // each row is an RPC round-trip; the outflow scan is several more

/**
 * GET /api/reconcile — the /proof ledger, checked against Arc.
 *
 * /proof is Merit's own account of what it settled. This endpoint is the audit of that account, run against
 * chain state, in both directions:
 *
 *   ledger → chain   every published settlement with a real tx hash is re-read from Arc: did it succeed, did
 *                    USDC of that size actually move, and do Arc's two USDC emitters (the 18-decimal native
 *                    system log and the 6-decimal ERC-20 log) tell the same story?
 *   chain  → ledger  a bounded scan of outbound USDC from the settlement wallet, flagging anything the ledger
 *                    does not explain — the failure ledger-side checking structurally cannot see.
 *
 * The point is that Merit's honesty claim stops depending on Merit. A reader runs this and sees the ledger
 * either survive the chain or not. Query params: `limit` (rows, default 25, max 100) and `blocks` (outflow
 * window, default 20,000 ≈ 2.9h; Arc's RPC caps each request at 10,000 blocks so the scan is chunked).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
  const blocks = Math.min(120_000, Math.max(1_000, Number(url.searchParams.get("blocks")) || 20_000));

  if (ephemeralStore()) {
    await Promise.all(["cards", "custody", "balance"].map((n) => hydrateDoc(n).catch(() => false)));
  }
  await Promise.all([refreshCardsFromMirror(), refreshCustodyFromMirror(), refreshBalanceFromMirror()].map((p) => p.catch(() => {})));

  // Everything Merit has published that moved money, classified by whether the chain can check it.
  //
  // Two settlement shapes exist and conflating them would misreport both. A direct payout carries a real
  // transaction hash and is reconcilable line by line. A nanopayment settled through Circle Gateway's
  // batching carries a TRANSFER ID — the batch lands on chain later, under a hash Merit never sees — so it
  // cannot be re-read from a receipt. Those are counted and disclosed here rather than dropped, because a
  // ledger audit that silently omits most of the ledger is not an audit.
  const rows: LedgerClaim[] = [];
  let gatewayCount = 0;
  let gatewayUsdc = 0;
  let accrualCount = 0;
  let accrualUsdc = 0;
  for (const c of listCards(500)) {
    if (!(typeof c.paidUsdc === "number" && c.paidUsdc > 0)) continue;
    const isTx = !!c.tx && /^0x[0-9a-fA-F]{64}$/.test(c.tx) && !!c.explorerUrl;
    if (isTx) {
      rows.push({ id: c.id, tx: c.tx as string, usdc: c.paidUsdc });
    } else if (c.custody) {
      // A custody accrual moved no USDC yet — it becomes on-chain only when the creator claims it.
      accrualCount += 1;
      accrualUsdc = round6(accrualUsdc + c.paidUsdc);
    } else {
      gatewayCount += 1;
      gatewayUsdc = round6(gatewayUsdc + c.paidUsdc);
    }
  }
  for (const p of allCustodyPayouts()) rows.push({ id: `custody:${p.id}`, tx: p.tx, usdc: p.amount, to: p.to });
  for (const w of allBalanceWithdrawals()) rows.push({ id: `withdraw:${w.id}`, tx: w.tx, usdc: w.amount, to: w.to });

  // A batched payout is one transaction carrying several ledger lines to the same payee; the chain cannot tell
  // those lines apart, so they are reconciled as one group against the movement they actually share.
  const grouped = groupClaims(rows);
  // Newest first, then bounded — a public endpoint must not fan out unboundedly over RPC.
  const selected = grouped.slice(-limit).reverse();
  const checked: RowReconciliation[] = [];
  for (const r of selected) checked.push(await reconcileRow(r));

  const matched = checked.filter((c) => c.status === "match");
  const failed = checked.filter((c) => c.status === "mismatch" || c.status === "reverted");
  const unreadable = checked.filter((c) => c.status === "not-found" || c.status === "unreadable");

  const wallet = custodyAddress();
  const known = new Set<string>(rows.map((r) => r.tx.toLowerCase()));
  let outflow = null;
  let outflowError: string | null = null;
  if (wallet) {
    try {
      outflow = await scanOutflows({ wallet, knownTxs: known, blocks, maxChunks: Math.ceil(blocks / 10_000) });
    } catch (e) {
      outflowError = `outflow scan failed — ${(e as Error).message.slice(0, 140)}`;
    }
  } else {
    outflowError = "no settlement wallet configured on this deployment";
  }

  return NextResponse.json({
    schema: "merit.reconcile/v1",
    chain: { chainId: ARC.chainId, usdc: ARC.usdc, systemTransferEmitter: ARC.systemTransferEmitter, explorer: ARC.explorer },
    // Direction 1 — does the chain back what we published?
    ledgerToChain: {
      rowsPublished: rows.length,
      settlementsChecked: checked.length, // (tx, payee) groups — a batch of k lines to one wallet is ONE settlement
      rowsChecked: checked.reduce((n, c) => n + c.ids.length, 0),
      matched: matched.length,
      failed: failed.length,
      unreadable: unreadable.length,
      claimedUsdc: round6(checked.reduce((s, c) => s + c.claimedUsdc, 0)),
      onchainUsdc: round6(checked.reduce((s, c) => s + (c.onchainUsdc || 0), 0)),
      // Both Arc emitters agreeing is an independent second witness to every row, not a restatement of the first.
      emitterCrossChecks: checked.filter((c) => c.emittersAgree === true).length,
      rows: checked,
    },
    // The published settlements this audit CANNOT check line by line, and why. Stated so the counts above are
    // never mistaken for the whole ledger.
    notChainCheckable: {
      gatewayBatched: { count: gatewayCount, usdc: gatewayUsdc, why: "settled through Circle Gateway batching, which returns a transfer id; the batch lands on chain later under a hash Merit never observes" },
      custodyAccruals: { count: accrualCount, usdc: accrualUsdc, why: "earned and held for a wallet-less creator — no USDC has moved yet, so there is nothing on chain to check until it is claimed" },
    },
    // Direction 2 — did anything leave without a published receipt?
    chainToLedger: outflow
      ? {
          wallet: outflow.wallet,
          window: outflow.window,
          transfersSeen: outflow.outflows.length,
          totalUsdc: outflow.totalUsdc,
          explainedUsdc: outflow.explainedUsdc,
          unexplainedUsdc: outflow.unexplainedUsdc,
          unexplained: outflow.unexplained,
          truncated: outflow.truncated,
          // Only the unexplained ones are listed: the explained ones are already in the ledger above.
          unexplainedTransfers: outflow.outflows.filter((o) => !o.explained),
        }
      : null,
    outflowError,
    note:
      "The outflow scan covers a bounded recent window (Arc's RPC caps eth_getLogs at 10,000 blocks per request). A clean scan means nothing unexplained IN THAT WINDOW — never that nothing is unexplained in all of history. Rows marked 'unreadable' are settlements published as Gateway batch transfer-ids rather than transaction hashes; they are not on-chain claims and are counted separately, never as passes.",
  });
}
