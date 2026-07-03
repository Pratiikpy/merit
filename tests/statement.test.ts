import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

let statement: typeof import("../lib/statement");
let audit: typeof import("../lib/audit");
let ledger: typeof import("../lib/ledger");

beforeEach(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-stmt-"));
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  vi.resetModules(); // fresh module state per test — the audit/ledger/metrics caches must not leak across tests
  statement = await import("../lib/statement");
  audit = await import("../lib/audit");
  ledger = await import("../lib/ledger");
});

function seedVerdict(verdict: "SUPPORTED" | "REFUSED") {
  audit.recordAuditVerdict(
    { verdict, grounded: verdict === "SUPPORTED", score: null, methods: ["numeric"], modelTag: "t", engineVersion: "e", sourceHash: "0x0" },
    `claim ${verdict} ${Math.random()}`,
  );
}

describe("buildStatement", () => {
  it("composes verification + settlement into a signed, id'd statement", async () => {
    seedVerdict("SUPPORTED");
    seedVerdict("SUPPORTED");
    seedVerdict("REFUSED");
    ledger.recordLedgerSettlement({ runId: "r1", sourceId: "s1", amount: 0.02, at: 1 });

    process.env.MERIT_SIGNING_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const s = await statement.buildStatement();
    delete process.env.MERIT_SIGNING_KEY;

    expect(s.schema).toBe("merit.statement/v1");
    expect(s.verification.total).toBe(3);
    expect(s.verification.supported).toBe(2);
    expect(s.verification.refused).toBe(1);
    expect(s.verification.refusedShare).toBeCloseTo(1 / 3, 3);
    expect(s.verification.chainValid).toBe(true); // untampered audit chain
    expect(s.settlement.totalSettledUsdc).toBeCloseTo(0.02, 6);
    expect(s.signer).toBeTruthy();
    expect(s.signature).toBeTruthy();
    expect(s.statementId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is stable/empty on a fresh deployment (no fabricated numbers)", async () => {
    const s = await statement.buildStatement({ sign: false });
    expect(s.verification.total).toBe(0);
    expect(s.verification.refusedShare).toBe(0);
    expect(s.settlement.totalSettledUsdc).toBe(0);
    expect(s.compliance.screens).toBe(0);
    expect(s.jury.panels).toBe(0);
    expect(s.attestation).toContain("proof-of-citation");
  });

  it("the statement id changes when the underlying totals change (tamper-evident)", async () => {
    const a = await statement.buildStatement({ sign: false });
    seedVerdict("REFUSED");
    const b = await statement.buildStatement({ sign: false });
    expect(a.statementId).not.toBe(b.statementId);
  });
});
