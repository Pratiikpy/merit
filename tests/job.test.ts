import { describe, it, expect, afterAll } from "vitest";
import { jobHookEnabled, settleViaHook, meritJobAddress, meritHookAddress } from "../lib/job";

const KEYS = ["MERIT_HOOK_ONCHAIN", "MERITJOB_ADDRESS", "MERIT_HOOK_ADDRESS", "STUB", "BUYER_PRIVATE_KEY", "OPERATOR_PRIVATE_KEY"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
const z = ("0x" + "0".repeat(64)) as `0x${string}`;

describe("lib/job (hook-gated ERC-8183 settlement — gating)", () => {
  afterAll(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is disabled by default; settleViaHook is a no-op returning null (never touches the chain)", async () => {
    process.env.STUB = "1";
    delete process.env.MERIT_HOOK_ONCHAIN;
    expect(jobHookEnabled()).toBe(false);
    expect(await settleViaHook({ amountAtomic: BigInt(1000), verified: true, deliverableHash: z, proofHash: z })).toBeNull();
  });

  it("stays OFF in STUB even with the flag + addresses + keys set (STUB forces it off)", () => {
    process.env.MERIT_HOOK_ONCHAIN = "1";
    process.env.MERITJOB_ADDRESS = "0x" + "a".repeat(40);
    process.env.MERIT_HOOK_ADDRESS = "0x" + "b".repeat(40);
    process.env.BUYER_PRIVATE_KEY = "0x" + "1".repeat(64);
    process.env.OPERATOR_PRIVATE_KEY = "0x" + "2".repeat(64);
    process.env.STUB = "1";
    expect(jobHookEnabled()).toBe(false);
  });

  it("parses configured addresses and rejects malformed ones", () => {
    process.env.MERITJOB_ADDRESS = "0x" + "a".repeat(40);
    process.env.MERIT_HOOK_ADDRESS = "0x" + "b".repeat(40);
    expect(meritJobAddress()).toBe("0x" + "a".repeat(40));
    expect(meritHookAddress()).toBe("0x" + "b".repeat(40));
    process.env.MERITJOB_ADDRESS = "notanaddress";
    expect(meritJobAddress()).toBeUndefined();
  });
});
