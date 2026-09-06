import { describe, it, expect } from "vitest";
import { keccak256, stringToHex, decodeFunctionData, hexToString, type Log } from "viem";
import {
  MAX_MEMO_BYTES,
  MEMO_ABI,
  MULTICALL3FROM_ABI,
  buildPayoutMemo,
  decodeMemoLogs,
  decodeTransferLogs,
  encodeAggregate3,
  encodeMemoCall,
  encodeUsdcTransfer,
  meritMemoId,
  memoEnabled,
  refsDigest,
  verifyMemoedTransfer,
  type MemoRef,
} from "../lib/memo";
import { ARC } from "../lib/arc";

/**
 * These fixtures are NOT invented. They are the four logs of a real Arc testnet transaction
 * (0x90eb74851a721eeac227db85fe3ca13ca77f69fecd6f7a6c0f5d96cc66aac57e) in which the Merit buyer EOA moved
 * 1 atomic USDC unit through the predeployed Memo contract. Testing the decoder against real chain bytes is
 * the point: an ABI that merely typechecks proves nothing about what Arc actually emits.
 */
const EOA = "0x415Fb8814084bDBC7B6964620Ba5Be5939aD2333";
const PAYEE = "0x20E0d0e4f478C0E8bFDD6f8451C240F5648BD294";
const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOPIC_MEMO = "0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4";
const TOPIC_BEFORE_MEMO = "0xb252e055da754c72fbf7542cf424b190808a9b541e912894c5e15b4238c41501";
const REAL_MEMO_ID = "0x3364b2831ffa9e37995d70ed9e7378919dcdaa4a101700659a635e3611f794c2";
const REAL_CALLDATA_HASH = "0xf8163bc93372a8bd81f8977ae240b5d6de210c396d9388d819b7e987320151f3";

const pad = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}` as `0x${string}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");

/** The positional fields every viem Log carries. Fixed values: the decoders under test read only the
 *  emitter address, the topics and the data, but a real Log has these and the fixtures should too. */
const LOG_META = {
  blockHash: `0x${"1".repeat(64)}` as `0x${string}`,
  blockNumber: BigInt(60_711_936),
  logIndex: 0,
  transactionHash: `0x${"2".repeat(64)}` as `0x${string}`,
  transactionIndex: 0,
  removed: false,
} as const;

function log(address: string, topics: `0x${string}`[], data: `0x${string}`): Log {
  return { ...LOG_META, address: address as `0x${string}`, topics, data } as unknown as Log;
}

function transferLog(emitter: string, from: string, to: string, value: bigint): Log {
  return log(emitter, [TOPIC_TRANSFER, pad(from), pad(to)], `0x${word(value)}` as `0x${string}`);
}

/** The real Memo log, re-encoded from its actual on-chain field values. */
function memoLog(opts: { memoId?: string; callDataHash?: string; body?: string } = {}): Log {
  const body = opts.body ?? '{"v":1,"probe":true}';
  const bodyHex = stringToHex(body).slice(2);
  const padded = bodyHex.padEnd(Math.ceil(bodyHex.length / 64) * 64, "0");
  // non-indexed tuple: (bytes32 callDataHash, bytes memo, uint256 memoIndex) — memo is dynamic, so a head
  // offset precedes it, exactly as the chain encodes it.
  const data =
    "0x" +
    (opts.callDataHash ?? REAL_CALLDATA_HASH).slice(2) + // callDataHash
    word(BigInt(96)) + // offset to `memo`
    word(BigInt(494453)) + // memoIndex
    word(BigInt(body.length)) + // memo length
    padded;
  return log(ARC.memo, [TOPIC_MEMO, pad(EOA), pad(ARC.usdc), (opts.memoId ?? REAL_MEMO_ID) as `0x${string}`], data as `0x${string}`);
}

/** The full real receipt: BeforeMemo, the 18-decimal system Transfer, the 6-decimal ERC-20 Transfer, Memo. */
function realReceiptLogs(): Log[] {
  return [
    log(ARC.memo, [TOPIC_BEFORE_MEMO, `0x${word(BigInt(494453))}` as `0x${string}`], "0x"),
    transferLog(ARC.systemTransferEmitter, EOA, PAYEE, BigInt("1000000000000")),
    transferLog(ARC.usdc, EOA, PAYEE, BigInt(1)),
    memoLog(),
  ];
}

describe("memo payload", () => {
  const refs: MemoRef[] = [
    { v: "0xaaa", a: 0.01 },
    { v: "0xbbb", a: 0.02 },
    { run: "run-7", a: 0.03 },
  ];

  it("digests the same refs to the same value and different refs to a different one", () => {
    expect(refsDigest(refs)).toBe(refsDigest([...refs]));
    expect(refsDigest(refs)).not.toBe(refsDigest([...refs, { v: "0xccc", a: 0.01 }]));
    // A changed AMOUNT must change the digest — otherwise the memo could not detect a restated payout.
    expect(refsDigest(refs)).not.toBe(refsDigest([{ v: "0xaaa", a: 0.011 }, refs[1], refs[2]]));
  });

  it("covers the run id as well as the verificationId", () => {
    expect(refsDigest([{ run: "run-7", a: 1 }])).not.toBe(refsDigest([{ run: "run-8", a: 1 }]));
  });

  it("derives memoId deterministically from (kind, id, digest)", () => {
    const dig = refsDigest(refs);
    expect(meritMemoId("custody-claim", "src-1", dig)).toBe(keccak256(stringToHex(`merit/custody-claim:src-1:${dig}`)));
    expect(meritMemoId("custody-claim", "src-1", dig)).not.toBe(meritMemoId("balance-withdrawal", "src-1", dig));
    expect(meritMemoId("custody-claim", "src-1", dig)).not.toBe(meritMemoId("custody-claim", "src-2", dig));
  });

  it("labels a run-derived ref so a reader can tell it from a verdict id", () => {
    const m = buildPayoutMemo({ kind: "custody-claim", id: "c1", amount: 0.03, refs: [{ run: "run-7", a: 0.03 }] });
    expect(m.payload.vids).toEqual(["run:run-7"]);
  });

  it("keeps the memo body inside the gas budget by dropping ids, never the digest", () => {
    const many: MemoRef[] = Array.from({ length: 60 }, (_, i) => ({ v: `0x${String(i).padStart(64, "0")}`, a: 0.001 }));
    const m = buildPayoutMemo({ kind: "custody-claim", id: "big", amount: 0.06, refs: many });
    const bytes = Buffer.byteLength(hexToString(m.memoData), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_MEMO_BYTES);
    expect(m.truncated).toBe(true);
    expect(m.payload.vids.length).toBeLessThan(many.length);
    // The count and the digest still describe ALL of them — truncation hides nothing.
    expect(m.payload.n).toBe(60);
    expect(m.payload.dig).toBe(refsDigest(many));
  });

  it("round-trips as plain UTF-8 JSON any indexer can read", () => {
    const m = buildPayoutMemo({ kind: "custody-claim", id: "c1", amount: 0.05, refs, at: "2026-09-06T00:00:00.000Z" });
    const parsed = JSON.parse(hexToString(m.memoData));
    expect(parsed.kind).toBe("custody-claim");
    expect(parsed.usdc).toBe("0.05");
    expect(parsed.n).toBe(3);
    expect(parsed.at).toBe("2026-09-06T00:00:00.000Z");
  });

  it("carries a note only when one is given", () => {
    expect(buildPayoutMemo({ kind: "custody-claim", id: "c", amount: 1, refs: [] }).payload.note).toBeUndefined();
    expect(buildPayoutMemo({ kind: "balance-withdrawal", id: "c", amount: 1, refs: [], note: "12 refused cost $0" }).payload.note).toBe("12 refused cost $0");
  });
});

describe("encoding", () => {
  it("wraps a USDC transfer so the inner calldata survives byte-for-byte", () => {
    const inner = encodeUsdcTransfer(PAYEE as `0x${string}`, BigInt(50_000));
    const wrapped = encodeMemoCall({ target: ARC.usdc as `0x${string}`, data: inner, memoId: REAL_MEMO_ID as `0x${string}`, memoData: stringToHex("{}") });
    const d = decodeFunctionData({ abi: MEMO_ABI, data: wrapped });
    expect(d.functionName).toBe("memo");
    expect(d.args[0].toLowerCase()).toBe(ARC.usdc.toLowerCase());
    expect(d.args[1]).toBe(inner); // the payload the USDC contract will actually execute
    expect(d.args[2]).toBe(REAL_MEMO_ID);
  });

  it("batches with allowFailure false by default — a verified basket is all-or-nothing", () => {
    const calls = [
      { target: ARC.usdc as `0x${string}`, callData: encodeUsdcTransfer(PAYEE as `0x${string}`, BigInt(1)) },
      { target: ARC.usdc as `0x${string}`, callData: encodeUsdcTransfer(EOA as `0x${string}`, BigInt(2)) },
    ];
    const d = decodeFunctionData({ abi: MULTICALL3FROM_ABI, data: encodeAggregate3(calls) });
    expect(d.functionName).toBe("aggregate3");
    expect(d.args[0]).toHaveLength(2);
    expect(d.args[0].every((c) => c.allowFailure === false)).toBe(true);
  });
});

describe("decoding real Arc logs", () => {
  it("decodes the Memo event exactly as Arc emitted it", () => {
    const [m] = decodeMemoLogs(realReceiptLogs());
    expect(m.sender.toLowerCase()).toBe(EOA.toLowerCase());
    expect(m.target.toLowerCase()).toBe(ARC.usdc.toLowerCase());
    expect(m.memoId).toBe(REAL_MEMO_ID);
    expect(m.callDataHash).toBe(REAL_CALLDATA_HASH);
    expect(m.memoIndex).toBe("494453");
    expect(m.text).toBe('{"v":1,"probe":true}');
  });

  it("does not claim a foreign application's memo is a Merit payload", () => {
    const [m] = decodeMemoLogs([memoLog({ body: "someone else's memo" })]);
    expect(m.text).toBe("someone else's memo");
    expect(m.payload).toBeNull();
  });

  it("reads each emitter at its OWN precision and never conflates them", () => {
    const ts = decodeTransferLogs(realReceiptLogs());
    const sys = ts.find((t) => t.emitter === "system")!;
    const erc = ts.find((t) => t.emitter === "erc20")!;
    // Same movement: 1 atomic ERC-20 unit (1e-6 USDC) is 1e12 system units (18 decimals).
    expect(erc.value).toBe(BigInt(1));
    expect(sys.value).toBe(BigInt("1000000000000"));
    expect(erc.usdc).toBe(sys.usdc);
    expect(erc.usdc).toBe(0.000001);
  });

  it("ignores logs from other contracts entirely", () => {
    const foreign = transferLog("0xdF81dcCFf8C8ea9E1FB6b5b2B790fAFF1EBe6A05", EOA, PAYEE, BigInt(5));
    expect(decodeTransferLogs([foreign])).toHaveLength(0);
    expect(decodeMemoLogs([foreign])).toHaveLength(0);
  });
});

describe("verifyMemoedTransfer", () => {
  const expectOk = { sender: EOA, to: PAYEE, atomic: BigInt(1) };

  it("passes on the real receipt, with sender preservation proven from the log", () => {
    const r = verifyMemoedTransfer({ logs: realReceiptLogs(), expect: expectOk });
    const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    // The probe memo is not a Merit payload, so the payload-derived check is expected to fail there and only
    // there. Everything about the MONEY must pass.
    expect(failed).toEqual(["memo-id-derives-from-payload: memo bytes are not a Merit payload"]);
    expect(r.checks.find((c) => c.name === "sender-preserved")!.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "calldata-hash-binds-transfer")!.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "system-log-agrees")!.ok).toBe(true);
  });

  it("catches a memo stapled onto a DIFFERENT transfer", () => {
    // Same memo, but the transfer actually moved 2 units, not 1 — callDataHash can no longer bind.
    const logs = [transferLog(ARC.systemTransferEmitter, EOA, PAYEE, BigInt("2000000000000")), transferLog(ARC.usdc, EOA, PAYEE, BigInt(2)), memoLog()];
    const r = verifyMemoedTransfer({ logs, expect: { sender: EOA, to: PAYEE, atomic: BigInt(2) } });
    expect(r.checks.find((c) => c.name === "calldata-hash-binds-transfer")!.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("catches a forged memoId that does not derive from its own payload", () => {
    const good = buildPayoutMemo({ kind: "custody-claim", id: "c1", amount: 0.000001, refs: [{ v: "0xaaa", a: 0.000001 }] });
    const forged = memoLog({ body: hexToString(good.memoData), memoId: keccak256(stringToHex("not-derived")) });
    const logs = [transferLog(ARC.systemTransferEmitter, EOA, PAYEE, BigInt("1000000000000")), transferLog(ARC.usdc, EOA, PAYEE, BigInt(1)), forged];
    const r = verifyMemoedTransfer({ logs, expect: expectOk });
    expect(r.checks.find((c) => c.name === "memo-id-derives-from-payload")!.ok).toBe(false);
  });

  it("catches a sender that is NOT the EOA — the failure the CallFrom precompile exists to prevent", () => {
    const logs = [
      transferLog(ARC.systemTransferEmitter, ARC.memo, PAYEE, BigInt("1000000000000")),
      transferLog(ARC.usdc, ARC.memo, PAYEE, BigInt(1)), // the wrapper contract as `from`
      memoLog(),
    ];
    const r = verifyMemoedTransfer({ logs, expect: expectOk });
    expect(r.checks.find((c) => c.name === "sender-preserved")!.ok).toBe(false);
  });

  it("catches the two emitters disagreeing", () => {
    const logs = [
      transferLog(ARC.systemTransferEmitter, EOA, PAYEE, BigInt("999000000000")), // wrong by 1e-9 USDC
      transferLog(ARC.usdc, EOA, PAYEE, BigInt(1)),
      memoLog(),
    ];
    const r = verifyMemoedTransfer({ logs, expect: expectOk });
    expect(r.checks.find((c) => c.name === "system-log-agrees")!.ok).toBe(false);
  });

  it("reports a receipt with no memo at all as failing, not as a pass", () => {
    const logs = [transferLog(ARC.usdc, EOA, PAYEE, BigInt(1))];
    const r = verifyMemoedTransfer({ logs, expect: expectOk });
    expect(r.checks.find((c) => c.name === "memo-event-present")!.ok).toBe(false);
    expect(r.ok).toBe(false);
  });
});

describe("kill switch", () => {
  it("is on by default and off only when explicitly disabled", () => {
    const prev = process.env.ARC_MEMO;
    try {
      delete process.env.ARC_MEMO;
      expect(memoEnabled()).toBe(true);
      process.env.ARC_MEMO = "1";
      expect(memoEnabled()).toBe(true);
      process.env.ARC_MEMO = "0";
      expect(memoEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ARC_MEMO;
      else process.env.ARC_MEMO = prev;
    }
  });
});
