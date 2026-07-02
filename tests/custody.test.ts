import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let dir: string;
let custody: typeof import("../lib/custody");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-custody-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE; // local-file store
  process.env.STUB = "1"; // no real chain in the unit test
  custody = await import("../lib/custody");
});

describe("custodial payout ledger", () => {
  it("accrues earnings per creator and tracks the unclaimed balance", () => {
    custody.accrueCustody("c_alice", "Alice Blog", 0.05, { domain: "alice.com" });
    custody.accrueCustody("c_alice", "Alice Blog", 0.02, { domain: "alice.com" });
    custody.accrueCustody("c_bob", "Bob News", 0.03, { domain: "bob.io" });

    expect(custody.custodyUnclaimed("c_alice")).toBeCloseTo(0.07, 6);
    expect(custody.custodyUnclaimed("c_bob")).toBeCloseTo(0.03, 6);
    expect(custody.custodyUnclaimed("c_nobody")).toBe(0);

    const byDomain = custody.custodyByDomain("ALICE.com"); // case-insensitive
    expect(byDomain.length).toBe(1);
    expect(byDomain[0].id).toBe("c_alice");
    expect(byDomain[0].earned).toBeCloseTo(0.07, 6);
  });

  it("ignores non-positive accruals", () => {
    const before = custody.custodyUnclaimed("c_bob");
    custody.accrueCustody("c_bob", "Bob News", 0, { domain: "bob.io" });
    custody.accrueCustody("c_bob", "Bob News", -5, { domain: "bob.io" });
    expect(custody.custodyUnclaimed("c_bob")).toBe(before);
  });

  it("refuses to disburse in stub/keyless mode (never fakes an on-chain claim)", async () => {
    const res = await custody.claimCustody("c_alice", "0x415Fb8814084bDBC7B6964620Ba5Be5939aD2333");
    expect("error" in res).toBe(true);
    expect(custody.custodyUnclaimed("c_alice")).toBeCloseTo(0.07, 6); // balance untouched on a failed claim
  });

  it("rejects a claim for an unknown creator", async () => {
    const res = await custody.claimCustody("c_nobody", "0x415Fb8814084bDBC7B6964620Ba5Be5939aD2333");
    expect("error" in res).toBe(true);
  });
});
