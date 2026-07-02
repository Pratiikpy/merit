import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

let dir: string;
let audit: typeof import("../lib/audit");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-audit-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE; // local-file store, no Supabase mirror
  audit = await import("../lib/audit");
});

const V = (verdict: "SUPPORTED" | "REFUSED") => ({
  verdict, grounded: verdict === "SUPPORTED", score: 0.9,
  methods: ["numeric", "nli"], modelTag: "test", engineVersion: "t", sourceHash: "0xabc",
});

describe("verification audit log (EU AI Act traceability)", () => {
  it("appends a tamper-evident, chained, newest-first log", () => {
    audit.recordAuditVerdict(V("SUPPORTED"), "claim one");
    audit.recordAuditVerdict(V("REFUSED"), "claim two");
    audit.recordAuditVerdict(V("SUPPORTED"), "claim three");
    expect(audit.auditCount()).toBe(3);

    const chain = audit.verifyAuditChain();
    expect(chain.valid).toBe(true);
    expect(chain.length).toBe(3);
    expect(chain.brokenAt).toBe(null);

    const entries = audit.auditEntries(10);
    expect(entries.length).toBe(3);
    expect(entries[0].claimPreview).toBe("claim three"); // newest first
    expect(entries[0].prevHash).toBe(entries[1].hash); // chained to the prior record
    expect(entries[2].prevHash).toBe("0x" + "0".repeat(64)); // genesis
    expect(entries[0].hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("detects tampering — a mutated past record breaks the chain", async () => {
    const file = path.join(dir, "audit.json");
    const log = JSON.parse(fs.readFileSync(file, "utf8"));
    // flip a past verdict WITHOUT recomputing its hash — exactly what a tamperer would do
    log.entries[0].verdict = log.entries[0].verdict === "SUPPORTED" ? "REFUSED" : "SUPPORTED";
    fs.writeFileSync(file, JSON.stringify(log));

    vi.resetModules();
    const fresh = await import("../lib/audit");
    const chain = fresh.verifyAuditChain();
    expect(chain.valid).toBe(false);
    expect(chain.brokenAt).toBe(0);
  });
});
