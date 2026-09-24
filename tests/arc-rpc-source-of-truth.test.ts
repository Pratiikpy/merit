import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A real bug, found by real money on Arc mainnet: `lib/memo.ts`'s `rpcUrl()` read
 * `process.env.ARC_RPC_URL || ARC.rpcUrl` — so with `ARC_NETWORK=mainnet` set but `.env.local` still
 * carrying `ARC_RPC_URL=https://rpc.testnet.arc.network` (true for every local dev setup, since that var
 * predates the mainnet split), every memoed payout silently broadcast to Arc TESTNET while the ledger,
 * contract addresses (`ARC.usdc`, `ARC.memo`, `ARC.multicall3From` — identical on both chains) and every
 * other signal looked correct. A real batched claim went out this way on 2026-09-24: the server returned
 * 200 with a real tx hash, the ledger recorded it as settled, and the transaction is on testnet block
 * 0x3cc249e — completely invisible to anything reading Arc mainnet, `/api/reconcile` included.
 *
 * The same pattern existed in `lib/balance.ts`, `lib/custody.ts`, `lib/reconcile.ts`, `lib/relay.ts` and
 * `app/api/memo/route.ts` (an `ARC_RPC_URL ||` fallback ahead of the network-aware `ARC.rpcUrl`), and in
 * `lib/pay.ts` / `lib/crosschain.ts` (`rpcUrl: process.env.ARC_RPC_URL` with no fallback at all — so Circle
 * Gateway calls would always target testnet regardless of `ARC_NETWORK`). All fixed to read `ARC.rpcUrl`
 * alone, which is already `process.env.ARC_RPC_URL || testnet-default` on testnet and
 * `process.env.ARC_MAINNET_RPC_URL` on mainnet — so nothing verified on testnet changed, and mainnet now
 * broadcasts to the chain it claims to.
 *
 * `ARC_RPC_URL` outside `lib/arc.ts` is therefore not a style preference to catch in review — it is exactly
 * the shape of the bug that shipped, so it is asserted against statically here, every run, on every file.
 */
const APP_ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["lib", "app"];
const ALLOWED = new Set([path.join("lib", "arc.ts")]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("Arc RPC endpoint has exactly one source of truth", () => {
  it("no app module reads process.env.ARC_RPC_URL directly — ARC.rpcUrl is the only allowed source", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(APP_ROOT, dir))) {
        const rel = path.relative(APP_ROOT, file);
        if (ALLOWED.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        if (src.includes("process.env.ARC_RPC_URL")) offenders.push(rel);
      }
    }
    expect(offenders, `these files read process.env.ARC_RPC_URL directly instead of ARC.rpcUrl, which silently re-introduces the testnet-broadcast-on-"mainnet" bug: ${offenders.join(", ")}`).toEqual([]);
  });
});

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("ARC.rpcUrl ignores ARC_RPC_URL on mainnet — the exact scenario that broke", () => {
  it("uses ARC_MAINNET_RPC_URL, not the testnet ARC_RPC_URL left over in .env.local", async () => {
    vi.resetModules();
    process.env.ARC_NETWORK = "mainnet";
    process.env.ARC_RPC_URL = "https://rpc.testnet.arc.network"; // exactly what every local .env.local carries
    process.env.ARC_MAINNET_CHAIN_ID = "5042";
    process.env.ARC_MAINNET_RPC_URL = "https://rpc.mainnet.arc.io";
    const { ARC } = await import("../lib/arc");
    expect(ARC.rpcUrl).toBe("https://rpc.mainnet.arc.io");
    expect(ARC.rpcUrl).not.toBe(process.env.ARC_RPC_URL);
  });

  it("testnet still reads ARC_RPC_URL — the fix changed nothing about the network this repo was verified on", async () => {
    vi.resetModules();
    delete process.env.ARC_NETWORK;
    process.env.ARC_RPC_URL = "https://rpc.testnet.arc.network";
    const { ARC } = await import("../lib/arc");
    expect(ARC.rpcUrl).toBe("https://rpc.testnet.arc.network");
  });
});

describe("getLogsResilient — the two Arc RPC caps, unit-tested against a fake client", () => {
  // A minimal fake client whose `getLogs` can be scripted to fail exactly like Arc's real RPC does: a span
  // over MAX_LOG_BLOCK_SPAN is refused, and (independently) a call whose true log count exceeds a configured
  // ceiling is refused too — mirroring the -32012 "range too large" and -32602 "exceeds max results" errors
  // this was written against.
  function fakeClient(allLogs: Array<{ blockNumber: bigint }>, opts: { resultCap?: number } = {}) {
    const resultCap = opts.resultCap ?? Infinity;
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    return {
      calls,
      getLogs: async (params: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push({ fromBlock: params.fromBlock, toBlock: params.toBlock });
        const span = params.toBlock - params.fromBlock + BigInt(1);
        if (span > BigInt(10_000)) throw new Error("requested range too large");
        const matched = allLogs.filter((l) => l.blockNumber >= params.fromBlock && l.blockNumber <= params.toBlock);
        if (matched.length > resultCap) throw new Error(`query exceeds max results ${resultCap}, retry with a smaller range`);
        return matched;
      },
    } as unknown as import("viem").PublicClient & { calls: typeof calls };
  }

  it("splits a >10,000-block request into <=10,000-block pieces and returns every log, in order", async () => {
    const { getLogsResilient } = await import("../lib/arc");
    const logs = [{ blockNumber: BigInt(5) }, { blockNumber: BigInt(15_000) }, { blockNumber: BigInt(25_000) }];
    const client = fakeClient(logs);
    const out = await getLogsResilient(client, { fromBlock: BigInt(0), toBlock: BigInt(25_000) });
    expect(out).toEqual(logs);
    expect(client.calls.every((c) => c.toBlock - c.fromBlock + BigInt(1) <= BigInt(10_000))).toBe(true);
  });

  it("bisects a chunk that exceeds the RESULT-COUNT cap — the exact failure mode Arc mainnet hit that testnet never did", async () => {
    const { getLogsResilient } = await import("../lib/arc");
    // 5 logs spread across a 9,000-block window, with a result cap of 2 — forces at least one real split.
    const logs = [1000, 3000, 5000, 7000, 9000].map((b) => ({ blockNumber: BigInt(b) }));
    const client = fakeClient(logs, { resultCap: 2 });
    const out = await getLogsResilient(client, { fromBlock: BigInt(0), toBlock: BigInt(9000) });
    expect(out.length).toBe(5);
    expect(new Set(out.map((l: { blockNumber: bigint }) => l.blockNumber.toString()))).toEqual(new Set(logs.map((l) => l.blockNumber.toString())));
    expect(client.calls.length).toBeGreaterThan(1); // it actually split, rather than throwing once
  });

  it("a single unsplittable block that still errors is a real error, not swallowed", async () => {
    const { getLogsResilient } = await import("../lib/arc");
    const client = { getLogs: async () => { throw new Error("query exceeds max results 2000"); } } as unknown as import("viem").PublicClient;
    await expect(getLogsResilient(client, { fromBlock: BigInt(100), toBlock: BigInt(100) })).rejects.toThrow(/exceeds max results/);
  });

  it("a non-cap error (RPC down, bad auth) is never retried or swallowed", async () => {
    const { getLogsResilient } = await import("../lib/arc");
    const client = { getLogs: async () => { throw new Error("Internal Server Error"); } } as unknown as import("viem").PublicClient;
    await expect(getLogsResilient(client, { fromBlock: BigInt(0), toBlock: BigInt(100) })).rejects.toThrow("Internal Server Error");
  });
});
