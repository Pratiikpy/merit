import { NextResponse } from "next/server";
import { createPublicClient, getAddress, http, keccak256, type Hex } from "viem";
import { ARC, explorerTx, round6 } from "@/lib/arc";
import {
  MEMO_EVENTS,
  decodeMemoLogs,
  decodeTransferLogs,
  encodeUsdcTransfer,
  meritMemoId,
  type DecodedMemo,
} from "@/lib/memo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The public memo reader — the surface that makes "the payment carries its own proof" checkable by a stranger.
 *
 *   GET /api/memo?tx=0x…                 read every Arc `Memo` attached to one transaction, and re-derive it
 *   GET /api/memo?id=0x…[&blocks=10000]  find payments by their bytes32 memoId, straight from chain logs
 *
 * Nothing here trusts Merit's own records. The route reads Arc, decodes the `Memo` event, and recomputes:
 * the memoId from the payload's own digest, and `callDataHash` from the exact USDC `transfer(to, amount)`
 * calldata implied by the accompanying Transfer log. If either recomputation disagrees, the response says so
 * — a memo that does not bind to its transfer is reported as failing, never quietly rendered.
 *
 * Arc's RPC caps `eth_getLogs` at 10,000 blocks per request (~86 minutes at Arc's ~0.52s blocks), so the
 * memoId lookup scans a bounded, explicitly-reported window rather than pretending to search all history.
 */

const MAX_BLOCKS = 10_000; // the RPC's hard per-request range limit, measured against Arc testnet
const MAX_CHUNKS = 12; // ≈17 hours of history; keeps a public, unauthenticated read bounded

function pub() {
  return createPublicClient({ transport: http(process.env.ARC_RPC_URL || ARC.rpcUrl) });
}

/** Re-derive everything the memo asserts about itself, from the receipt alone. */
function auditMemo(m: DecodedMemo, transferTo?: string, transferAtomic?: bigint) {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  if (m.payload) {
    const derived = meritMemoId(m.payload.kind, m.payload.id, m.payload.dig);
    checks.push({
      name: "memoId derives from the payload's own digest",
      ok: derived.toLowerCase() === m.memoId.toLowerCase(),
      detail: `on-chain ${m.memoId} · recomputed ${derived}`,
    });
  } else {
    checks.push({ name: "memo carries a Merit payload", ok: false, detail: "memo bytes are not a merit payout payload" });
  }
  if (transferTo && transferAtomic !== undefined) {
    const recomputed = keccak256(encodeUsdcTransfer(getAddress(transferTo), transferAtomic));
    checks.push({
      name: "callDataHash binds the memo to THIS transfer",
      ok: recomputed.toLowerCase() === m.callDataHash.toLowerCase(),
      detail: `on-chain ${m.callDataHash} · recomputed from transfer(${transferTo}, ${transferAtomic}) ${recomputed}`,
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tx = (url.searchParams.get("tx") || "").trim();
  const id = (url.searchParams.get("id") || "").trim();

  if (!tx && !id) {
    return NextResponse.json(
      {
        error: "provide ?tx=<0x hash> to read a payment's memos, or ?id=<0x bytes32 memoId> to find payments by memo id",
        contract: ARC.memo,
        chainId: ARC.chainId,
      },
      { status: 400 },
    );
  }

  if (tx) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return NextResponse.json({ error: "tx must be a 0x-prefixed 32-byte hash" }, { status: 400 });
    let rc;
    try {
      rc = await pub().getTransactionReceipt({ hash: tx as Hex });
    } catch (e) {
      return NextResponse.json({ error: `could not read that transaction on Arc — ${(e as Error).message.slice(0, 120)}` }, { status: 404 });
    }
    const memos = decodeMemoLogs(rc.logs);
    const transfers = decodeTransferLogs(rc.logs);
    // The 6-decimal ERC-20 stream is the payment; the 18-decimal system stream is the independent second
    // witness. Report both, never summed together.
    const erc20 = transfers.filter((t) => t.emitter === "erc20");
    const system = transfers.filter((t) => t.emitter === "system");
    return NextResponse.json({
      schema: "merit.memo/v1",
      tx,
      status: rc.status,
      explorerUrl: explorerTx(tx),
      memoContract: ARC.memo,
      memos: memos.map((m, i) => {
        const t = erc20[i] || erc20[0];
        return {
          memoId: m.memoId,
          memoIndex: m.memoIndex,
          sender: m.sender,
          target: m.target,
          callDataHash: m.callDataHash,
          text: m.text,
          payload: m.payload,
          audit: auditMemo(m, t?.to, t?.value),
        };
      }),
      transfers: {
        // Sender preservation is the point of the CallFrom precompile: `from` is the operator EOA, never the
        // Memo/Multicall3From wrapper. Rendered here so a reader can see it without decoding anything.
        erc20: erc20.map((t) => ({ from: t.from, to: t.to, usdc: t.usdc, atomic: t.value.toString(), decimals: 6 })),
        system: system.map((t) => ({ from: t.from, to: t.to, usdc: t.usdc, wei: t.value.toString(), decimals: 18 })),
      },
    });
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return NextResponse.json({ error: "id must be a 0x-prefixed bytes32 memoId" }, { status: 400 });
  const wanted = Math.max(1, Math.min(MAX_BLOCKS * MAX_CHUNKS, Number(url.searchParams.get("blocks")) || MAX_BLOCKS));
  const client = pub();
  let head: bigint;
  try {
    head = await client.getBlockNumber();
  } catch (e) {
    return NextResponse.json({ error: `Arc RPC unavailable — ${(e as Error).message.slice(0, 120)}` }, { status: 502 });
  }
  const from = head - BigInt(wanted) < BigInt(0) ? BigInt(0) : head - BigInt(wanted);

  const found: Array<Record<string, unknown>> = [];
  let cursor = from;
  let scanned = 0;
  while (cursor <= head && scanned < MAX_CHUNKS) {
    const end = cursor + BigInt(MAX_BLOCKS) > head ? head : cursor + BigInt(MAX_BLOCKS);
    try {
      const logs = await client.getLogs({
        address: ARC.memo as `0x${string}`,
        event: MEMO_EVENTS[0],
        args: { memoId: id as Hex },
        fromBlock: cursor,
        toBlock: end,
      });
      for (const m of decodeMemoLogs(logs)) {
        const src = logs.find((l) => l.topics[3]?.toLowerCase() === id.toLowerCase());
        found.push({
          memoId: m.memoId,
          sender: m.sender,
          target: m.target,
          callDataHash: m.callDataHash,
          payload: m.payload,
          text: m.text,
          tx: src?.transactionHash || null,
          block: src?.blockNumber ? Number(src.blockNumber) : null,
          explorerUrl: src?.transactionHash ? explorerTx(src.transactionHash) : null,
        });
      }
    } catch (e) {
      return NextResponse.json(
        { error: `log scan failed at blocks ${cursor}-${end} — ${(e as Error).message.slice(0, 120)}`, partial: found },
        { status: 502 },
      );
    }
    cursor = end + BigInt(1);
    scanned += 1;
  }

  return NextResponse.json({
    schema: "merit.memo.lookup/v1",
    memoId: id,
    memoContract: ARC.memo,
    // Say exactly what was searched. A public reader must never read "not found" as "does not exist".
    window: { fromBlock: Number(from), toBlock: Number(head), blocks: Number(head - from), approxHours: round6(Number(head - from) * 0.5162 / 3600) },
    note: "Arc's RPC caps eth_getLogs at 10,000 blocks per request; this is a bounded recent-history scan, not all of chain history.",
    count: found.length,
    memos: found,
  });
}
