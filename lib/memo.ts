/**
 * Arc transaction memos — the verdict travels INSIDE the payment.
 *
 * Merit's thesis is that the payment IS the proof. Until now the proof lived beside the money: a signed verdict
 * served by onmerit.xyz, and a bare ERC-20 `transfer` on Arc that carried none of it. Arc's predeployed `Memo`
 * contract closes that gap. It wraps the transfer, routes it through the `CallFrom` precompile — so USDC still
 * sees the operator EOA as `msg.sender`, not a wrapper contract — and emits the metadata as an indexed event:
 *
 *   BeforeMemo(memoIndex)                                   ← before the inner call
 *   Transfer(from, to, value)  ×2                           ← the native 18-dec system log, then the 6-dec ERC-20 log
 *   Memo(sender, target, callDataHash, memoId, memo, memoIndex)
 *
 * So every Merit payout leaves an on-chain record of WHICH verified work it settled, queryable by `memoId` by
 * anyone, with no trust in Merit's servers at all. `callDataHash` is keccak256 of the forwarded calldata, so a
 * reader can independently confirm the memo is bound to that exact transfer (this recipient, this amount) and
 * not stapled onto an unrelated one.
 *
 * `Multicall3From` gives the same sender preservation for a BATCH, and the two compose: one transaction, k
 * transfers, k memos. Verified against Arc testnet — deployment (eth_getCode), simulation of all four call
 * shapes, and a real broadcast whose `Transfer.from` is the EOA and whose `callDataHash` recomputes exactly.
 *
 * EOA ONLY. Both contracts reject a smart-contract wallet as the direct caller (ERC-4337, Circle SCA/modular,
 * Safe): `CallFrom` refuses sender spoofing. Merit signs payouts with a raw EOA key, which qualifies — but any
 * future SCA payout path must fall back to a plain transfer, which `sendMemoedTransfer` does automatically.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  stringToHex,
  hexToString,
  type Hex,
  type Log,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { ARC, round6 } from "./arc";
import { canonicalize } from "./receipt";

// ---------------------------------------------------------------------------------------------------------
// ABIs — every signature below was confirmed against a real Arc testnet transaction, not inferred from docs.
// ---------------------------------------------------------------------------------------------------------

export const MEMO_ABI = [
  {
    type: "function",
    name: "memo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      { name: "memoId", type: "bytes32" },
      { name: "memoData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const MEMO_EVENTS = [
  {
    type: "event",
    name: "Memo",
    inputs: [
      { indexed: true, name: "sender", type: "address" },
      { indexed: true, name: "target", type: "address" },
      { indexed: false, name: "callDataHash", type: "bytes32" },
      { indexed: true, name: "memoId", type: "bytes32" },
      { indexed: false, name: "memo", type: "bytes" },
      { indexed: false, name: "memoIndex", type: "uint256" },
    ],
  },
  { type: "event", name: "BeforeMemo", inputs: [{ indexed: true, name: "memoIndex", type: "uint256" }] },
] as const;

export const MULTICALL3FROM_ABI = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

export const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export const TRANSFER_EVENT = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
] as const;

// ---------------------------------------------------------------------------------------------------------
// The memo payload
// ---------------------------------------------------------------------------------------------------------

/** How much memo body we are willing to pay for. Calldata costs 16 gas per non-zero byte, so an unbounded
 *  verificationId list would make a large payout arbitrarily expensive. The list is truncated to fit; the
 *  digest always covers the FULL set, so truncation never hides anything. */
export const MAX_MEMO_BYTES = 480;

/** What Merit writes into `memoData`: a compact, canonical (sorted-key) JSON object, UTF-8 encoded. Readable
 *  by any indexer with `hexToString` — no Merit-specific decoder needed. */
export interface MeritMemo {
  /** payload schema — bump if the field set ever changes */
  v: 1;
  /** what this payment is: a custody disbursement, a prepaid withdrawal, a batch line */
  kind: "custody-claim" | "balance-withdrawal" | "batch-payout";
  /** who is being paid, in Merit's own namespace (a creator/source id or a principal id) */
  id: string;
  /** the amount, in human USDC units, as an exact decimal string */
  usdc: string;
  /** how many settlement refs the digest covers */
  n: number;
  /** the verificationIds behind it — truncated to fit MAX_MEMO_BYTES; `dig` still covers all of them */
  vids: string[];
  /** keccak256 over the canonical FULL list of settlement refs — the tamper-evident cover for `vids` */
  dig: Hex;
  /** a short human summary of what this payment settles — present when the numbers alone don't say it (a
   *  prepaid withdrawal, for instance, is the UNSPENT remainder, and the note carries the verified/refused
   *  split that produced it) */
  note?: string;
  /** when Merit built the memo (ISO-8601) */
  at: string;
}

/** One accrued settlement behind a payout: what released it, and how much it released.
 *
 *  `v` is present when the accrual came from a single signed verdict (a Merit Link citation, a /api/buy
 *  purchase, a net-settlement line) and is that verdict's verificationId — the same join key the receipt,
 *  the /proof ledger and the settlement hook use. `run` is present instead when the accrual came from an
 *  agent RUN, whose proof is one signed run receipt covering many sources rather than a per-source verdict.
 *  A ref may legitimately carry neither, and then it contributes only its amount: the digest still covers it,
 *  and the memo never implies an id it does not have. */
export interface MemoRef {
  v?: string; // verificationId of the signed verdict that released this accrual
  run?: string; // Merit run id, when the accrual came from an agent run
  a: number; // USDC
  at?: number; // epoch ms
}

/** The digest that covers every ref behind a payout, whether or not it fits in the memo body. Domain-separated
 *  ("merit.memo.refs/v1") so it can never collide with another Merit hash preimage. */
export function refsDigest(refs: MemoRef[]): Hex {
  const canonical = canonicalize({
    t: "merit.memo.refs/v1",
    refs: refs.map((r) => ({ a: round6(r.a), run: r.run || "", v: r.v || "" })),
  });
  return keccak256(stringToHex(canonical));
}

/** The bytes32 lookup key. Deterministic in (kind, id, digest), so the same payout always yields the same id
 *  and a third party can recompute it from the receipt alone and query `Memo` events by it. */
export function meritMemoId(kind: MeritMemo["kind"], id: string, dig: Hex): Hex {
  return keccak256(stringToHex(`merit/${kind}:${id}:${dig}`));
}

/** Build the on-chain memo for a payout. Truncates `vids` (never the digest) until the encoded body fits. */
export function buildPayoutMemo(input: {
  kind: MeritMemo["kind"];
  id: string;
  amount: number;
  refs: MemoRef[];
  note?: string;
  at?: string;
}): { memoId: Hex; memoData: Hex; payload: MeritMemo; truncated: boolean } {
  const dig = refsDigest(input.refs);
  // Prefer the per-verdict id; fall back to the run id, tagged so a reader can tell the two apart at a glance.
  const allVids = input.refs
    .map((r) => (r.v ? r.v : r.run ? `run:${r.run}` : null))
    .filter((v): v is string => !!v);
  let vids = allVids.slice();
  const make = (list: string[]): MeritMemo => ({
    v: 1,
    kind: input.kind,
    id: input.id,
    usdc: round6(input.amount).toString(),
    n: input.refs.length,
    vids: list,
    dig,
    ...(input.note ? { note: input.note } : {}),
    at: input.at || new Date().toISOString(),
  });
  // Shrink the id list until the UTF-8 body fits the budget. `dig` covers the full set either way.
  let payload = make(vids);
  while (vids.length > 0 && Buffer.byteLength(canonicalize(payload), "utf8") > MAX_MEMO_BYTES) {
    vids = vids.slice(0, vids.length - 1);
    payload = make(vids);
  }
  return {
    memoId: meritMemoId(input.kind, input.id, dig),
    memoData: stringToHex(canonicalize(payload)),
    payload,
    truncated: vids.length < allVids.length,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------------------

/** Calldata for a single USDC `transfer`, in atomic (6-decimal) units. */
export function encodeUsdcTransfer(to: `0x${string}`, atomic: bigint): Hex {
  return encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [to, atomic] });
}

/** Calldata for `Memo.memo(target, data, memoId, memoData)`. */
export function encodeMemoCall(input: { target: `0x${string}`; data: Hex; memoId: Hex; memoData: Hex }): Hex {
  return encodeFunctionData({
    abi: MEMO_ABI,
    functionName: "memo",
    args: [input.target, input.data, input.memoId, input.memoData],
  });
}

/** Calldata for `Multicall3From.aggregate3`. `allowFailure:false` on every line by default: a partially-paid
 *  verified basket is worse than a clean retry, and the batch must be all-or-nothing to stay reconcilable. */
export function encodeAggregate3(calls: Array<{ target: `0x${string}`; callData: Hex; allowFailure?: boolean }>): Hex {
  return encodeFunctionData({
    abi: MULTICALL3FROM_ABI,
    functionName: "aggregate3",
    args: [calls.map((c) => ({ target: c.target, allowFailure: c.allowFailure ?? false, callData: c.callData }))],
  });
}

// ---------------------------------------------------------------------------------------------------------
// Decoding + independent verification
// ---------------------------------------------------------------------------------------------------------

export interface DecodedMemo {
  sender: string;
  target: string;
  callDataHash: Hex;
  memoId: Hex;
  memoIndex: string;
  /** the raw memo bytes, and the parsed Merit payload when it is one */
  raw: Hex;
  text: string | null;
  payload: MeritMemo | null;
}

export interface DecodedTransfer {
  emitter: "system" | "erc20" | "other";
  address: string;
  from: string;
  to: string;
  value: bigint;
  /** human USDC, using the emitter's own precision: 18 decimals for the native system log, 6 for the ERC-20 */
  usdc: number;
}

function sameAddr(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/** Decode every `Memo` event in a log set. Non-memo logs and undecodable ones are skipped, never guessed at. */
export function decodeMemoLogs(logs: readonly Log[]): DecodedMemo[] {
  const out: DecodedMemo[] = [];
  for (const log of logs) {
    if (!sameAddr(log.address, ARC.memo)) continue;
    let d;
    try {
      d = decodeEventLog({ abi: MEMO_EVENTS, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (d.eventName !== "Memo") continue;
    const a = d.args as unknown as { sender: string; target: string; callDataHash: Hex; memoId: Hex; memo: Hex; memoIndex: bigint };
    let text: string | null = null;
    let payload: MeritMemo | null = null;
    try {
      text = hexToString(a.memo);
      const parsed = JSON.parse(text) as MeritMemo;
      // Only claim it is a Merit payload when it actually carries the shape we write.
      if (parsed && parsed.v === 1 && typeof parsed.kind === "string" && typeof parsed.dig === "string") payload = parsed;
    } catch {
      /* memo bytes need not be JSON — another application's memo is data, not an error */
    }
    out.push({
      sender: a.sender,
      target: a.target,
      callDataHash: a.callDataHash,
      memoId: a.memoId,
      memoIndex: a.memoIndex.toString(),
      raw: a.memo,
      text,
      payload,
    });
  }
  return out;
}

/** Decode every USDC `Transfer` in a log set, tagged by which emitter produced it (and therefore at which
 *  precision). Both emitters log the same movement, so a caller must pick ONE stream to sum. */
export function decodeTransferLogs(logs: readonly Log[]): DecodedTransfer[] {
  const out: DecodedTransfer[] = [];
  for (const log of logs) {
    const isSystem = sameAddr(log.address, ARC.systemTransferEmitter);
    const isErc20 = sameAddr(log.address, ARC.usdc);
    if (!isSystem && !isErc20) continue;
    let d;
    try {
      d = decodeEventLog({ abi: TRANSFER_EVENT, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const a = d.args as unknown as { from: string; to: string; value: bigint };
    const decimals = isSystem ? 1e18 : 1e6;
    out.push({
      emitter: isSystem ? "system" : "erc20",
      address: log.address,
      from: a.from,
      to: a.to,
      value: a.value,
      usdc: round6(Number(a.value) / decimals),
    });
  }
  return out;
}

export interface MemoVerification {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  memo: DecodedMemo | null;
  erc20: DecodedTransfer | null;
  system: DecodedTransfer | null;
}

/**
 * Independently verify that a receipt really is the memoed payout it claims to be. Every check recomputes from
 * the logs rather than trusting anything Merit stored:
 *
 *  1. a `Memo` event exists, from the expected sender, targeting USDC
 *  2. `callDataHash` equals keccak256 of the exact `transfer(to, atomic)` calldata — binding the memo to THIS
 *     recipient and THIS amount, so it cannot have been stapled onto a different transfer
 *  3. `memoId` recomputes from the payload's own digest — so the lookup key is derived, not asserted
 *  4. the 6-decimal ERC-20 Transfer matches to/value, and `from` is the EOA (sender preservation held)
 *  5. the 18-decimal native system Transfer agrees with it — the two emitters tell the same story
 */
export function verifyMemoedTransfer(input: {
  logs: readonly Log[];
  expect: { sender: string; to: string; atomic: bigint; kind?: MeritMemo["kind"]; id?: string };
}): MemoVerification {
  const checks: MemoVerification["checks"] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const memos = decodeMemoLogs(input.logs);
  const transfers = decodeTransferLogs(input.logs);
  const to = input.expect.to;

  const memo =
    memos.find((m) => sameAddr(m.target, ARC.usdc) && sameAddr(m.sender, input.expect.sender)) || memos[0] || null;
  add("memo-event-present", !!memo, memo ? `Memo event at index ${memo.memoIndex}` : "no Memo event in this receipt");

  const expectedCallData = encodeUsdcTransfer(getAddress(to), input.expect.atomic);
  const expectedHash = keccak256(expectedCallData);
  add(
    "calldata-hash-binds-transfer",
    !!memo && memo.callDataHash.toLowerCase() === expectedHash.toLowerCase(),
    memo ? `on-chain ${memo.callDataHash} vs recomputed ${expectedHash}` : "no memo to check",
  );

  if (memo?.payload) {
    const expectedId = meritMemoId(memo.payload.kind, memo.payload.id, memo.payload.dig);
    add(
      "memo-id-derives-from-payload",
      expectedId.toLowerCase() === memo.memoId.toLowerCase(),
      `on-chain ${memo.memoId} vs recomputed ${expectedId}`,
    );
    if (input.expect.kind) add("kind-matches", memo.payload.kind === input.expect.kind, `${memo.payload.kind}`);
    if (input.expect.id) add("payee-id-matches", memo.payload.id === input.expect.id, `${memo.payload.id}`);
  } else if (memo) {
    add("memo-id-derives-from-payload", false, "memo bytes are not a Merit payload");
  }

  const erc20 = transfers.find((t) => t.emitter === "erc20" && sameAddr(t.to, to)) || null;
  add(
    "erc20-transfer-matches",
    !!erc20 && erc20.value === input.expect.atomic,
    erc20 ? `${erc20.value} atomic units to ${erc20.to}` : "no ERC-20 Transfer to the payee",
  );
  add(
    "sender-preserved",
    !!erc20 && sameAddr(erc20.from, input.expect.sender),
    erc20 ? `Transfer.from = ${erc20.from} (expected the EOA ${input.expect.sender}, NOT the Memo contract)` : "no ERC-20 Transfer",
  );

  // The native system log carries the same movement at 18 decimals. 1 atomic ERC-20 unit == 1e12 system units.
  const system = transfers.find((t) => t.emitter === "system" && sameAddr(t.to, to)) || null;
  add(
    "system-log-agrees",
    !!system && !!erc20 && system.value === erc20.value * BigInt(1e12),
    system && erc20 ? `system ${system.value} (18dp) vs erc20 ${erc20.value} (6dp) × 1e12` : "no native system Transfer",
  );

  return { ok: checks.every((c) => c.ok), checks, memo, erc20, system };
}

// ---------------------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------------------

/** Memoed payouts are on by default on a live deployment; `ARC_MEMO=0` turns them off without touching code
 *  (the payout then falls back to a plain ERC-20 transfer, ~22k gas cheaper and with no on-chain proof). */
export function memoEnabled(): boolean {
  return process.env.ARC_MEMO !== "0";
}

export interface MemoSendResult {
  hash: Hex;
  /** true when the transfer actually went through the Memo contract */
  memoed: boolean;
  memoId: Hex | null;
  /** why the memo path was skipped, when it was — always stated, never silently dropped */
  fallbackReason: string | null;
}

function rpcUrl(): string {
  return process.env.ARC_RPC_URL || ARC.rpcUrl;
}

/**
 * Send a USDC transfer wrapped in an Arc memo, falling back to a plain transfer if the memo path can't be used.
 *
 * The fallback is deliberate and reported, never silent: the money must move even if the wrapper is
 * unavailable (kill-switch off, an SCA signer, an RPC that can't simulate the wrapper). A pre-flight
 * `eth_call` decides — so a memo that WOULD revert costs nothing and degrades to the plain path, while a
 * revert after broadcast is surfaced to the caller as a failed payout rather than retried behind their back.
 */
export async function sendMemoedTransfer(input: {
  account: PrivateKeyAccount;
  to: `0x${string}`;
  atomic: bigint;
  memo?: { memoId: Hex; memoData: Hex };
}): Promise<MemoSendResult> {
  const wallet = createWalletClient({ account: input.account, transport: http(rpcUrl()) });
  const transferData = encodeUsdcTransfer(input.to, input.atomic);
  const plain = async (reason: string | null): Promise<MemoSendResult> => ({
    hash: await wallet.sendTransaction({ to: ARC.usdc as `0x${string}`, data: transferData, chain: null }),
    memoed: false,
    memoId: null,
    fallbackReason: reason,
  });

  if (!input.memo) return plain("no memo payload supplied");
  if (!memoEnabled()) return plain("memos disabled (ARC_MEMO=0)");

  const memoData = encodeMemoCall({ target: ARC.usdc as `0x${string}`, data: transferData, memoId: input.memo.memoId, memoData: input.memo.memoData });
  try {
    const pub = createPublicClient({ transport: http(rpcUrl()) });
    await pub.call({ account: input.account.address, to: ARC.memo as `0x${string}`, data: memoData });
  } catch (e) {
    return plain(`memo pre-flight reverted (${(e as Error).message.slice(0, 100)}) — sent as a plain transfer`);
  }
  const hash = await wallet.sendTransaction({ to: ARC.memo as `0x${string}`, data: memoData, chain: null });
  return { hash, memoed: true, memoId: input.memo.memoId, fallbackReason: null };
}

export interface BatchLineInput {
  to: `0x${string}`;
  atomic: bigint;
  memo?: { memoId: Hex; memoData: Hex };
}

export interface BatchSendResult {
  hash: Hex;
  /** how many transfers went out in this ONE transaction */
  lines: number;
  memoed: boolean;
  fallbackReason: string | null;
}

/**
 * Pay a whole verified basket in ONE Arc transaction via `Multicall3From`, each line carrying its own memo.
 *
 * Shape: `aggregate3([ Memo.memo(USDC, transfer(to_i, amt_i), memoId_i, memoData_i) … ])` — nested
 * CallFrom, confirmed working on Arc testnet by simulation of the exact call. `allowFailure` is false on every
 * line, so the batch is atomic: either the whole verified basket settles or none of it does and it can be
 * retried cleanly. Falls back to an unmemoed batch (still one transaction) if the memoed shape can't pre-flight,
 * and reports why.
 */
export async function sendMemoedBatch(input: { account: PrivateKeyAccount; lines: BatchLineInput[] }): Promise<BatchSendResult> {
  if (input.lines.length === 0) throw new Error("a batch needs at least one line");
  const wallet = createWalletClient({ account: input.account, transport: http(rpcUrl()) });
  const pub = createPublicClient({ transport: http(rpcUrl()) });
  const usdc = ARC.usdc as `0x${string}`;

  const plainCalls = input.lines.map((l) => ({ target: usdc, callData: encodeUsdcTransfer(l.to, l.atomic) }));
  const plain = async (reason: string | null): Promise<BatchSendResult> => ({
    hash: await wallet.sendTransaction({ to: ARC.multicall3From as `0x${string}`, data: encodeAggregate3(plainCalls), chain: null }),
    lines: input.lines.length,
    memoed: false,
    fallbackReason: reason,
  });

  const allMemoed = input.lines.every((l) => !!l.memo);
  if (!allMemoed) return plain("not every line carried a memo payload");
  if (!memoEnabled()) return plain("memos disabled (ARC_MEMO=0)");

  const memoCalls = input.lines.map((l) => ({
    target: ARC.memo as `0x${string}`,
    callData: encodeMemoCall({ target: usdc, data: encodeUsdcTransfer(l.to, l.atomic), memoId: l.memo!.memoId, memoData: l.memo!.memoData }),
  }));
  const data = encodeAggregate3(memoCalls);
  try {
    await pub.call({ account: input.account.address, to: ARC.multicall3From as `0x${string}`, data });
  } catch (e) {
    return plain(`memoed batch pre-flight reverted (${(e as Error).message.slice(0, 100)}) — sent as a plain batch`);
  }
  const hash = await wallet.sendTransaction({ to: ARC.multicall3From as `0x${string}`, data, chain: null });
  return { hash, lines: input.lines.length, memoed: true, fallbackReason: null };
}

/** Fetch a transaction's receipt and decode every memo it carries. Used by the public memo reader. */
export async function readMemoTx(hash: Hex): Promise<{ status: string; memos: DecodedMemo[]; transfers: DecodedTransfer[] }> {
  const pub = createPublicClient({ transport: http(rpcUrl()) });
  const rc = await pub.getTransactionReceipt({ hash });
  return { status: rc.status, memos: decodeMemoLogs(rc.logs), transfers: decodeTransferLogs(rc.logs) };
}
