import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let insurance: typeof import("../lib/insurance");

beforeAll(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-insurance-"));
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  delete process.env.INSURANCE_ONCHAIN; // off-chain resolution by the same two verdicts
  delete process.env.LLM_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.OPENAI_API_KEY;
  insurance = await import("../lib/insurance");
});

describe("agentic insurance — a guarantee market on Merit's own verdicts", () => {
  it("validates the policy inputs", async () => {
    const a = await insurance.createPolicy({ claim: "", source: "s", coverageUsdc: 0.1, premiumUsdc: 0.01 });
    expect("error" in a && a.status).toBe(400);
    const b = await insurance.createPolicy({ claim: "c", source: "", coverageUsdc: 0.1, premiumUsdc: 0.01 });
    expect("error" in b && b.status).toBe(400);
    const c = await insurance.createPolicy({ claim: "c", source: "s", coverageUsdc: 0, premiumUsdc: 0 });
    expect("error" in c && c.status).toBe(400); // coverage must be > 0
    const d = await insurance.createPolicy({ claim: "c", source: "s", coverageUsdc: 0.1, premiumUsdc: 0.5 });
    expect("error" in d && d.status).toBe(400); // premium cannot exceed coverage
    const e = await insurance.createPolicy({ claim: "c", source: "s", coverageUsdc: 999, premiumUsdc: 1 });
    expect("error" in e && e.status).toBe(400); // over the deployment's coverage cap
  });

  it("creates an open policy insuring whatever the free verifier decided, with a stable bytes32 id", async () => {
    const res = await insurance.createPolicy({
      claim: "Settlement reached $40 trillion in 2026.",
      source: "The report states settlement reached $4.1 trillion in 2026.",
      coverageUsdc: 0.2,
      premiumUsdc: 0.02,
    });
    expect("policy" in res).toBe(true);
    if ("policy" in res) {
      expect(res.policy.status).toBe("open");
      expect(res.policy.policyId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(res.policy.originalVerdict).toBe("REFUSED"); // the source contradicts the claim
      expect(res.policy.coverageUsdc).toBe(0.2);
      expect(res.policy.sourcePreview.length).toBeGreaterThan(0);
      expect(insurance.getPolicy(res.policy.id)?.claim).toContain("$40 trillion");
    }
  });

  it("resolves: the jury AGREEING with the original free verdict releases the reservation, not a payout", async () => {
    const created = await insurance.createPolicy({
      claim: "Settlement reached $40 trillion in 2026.",
      source: "The report states settlement reached $4.1 trillion in 2026.",
      coverageUsdc: 0.2,
      premiumUsdc: 0.02,
    });
    if (!("policy" in created)) throw new Error("create failed");
    const res = await insurance.resolvePolicy(created.policy.id);
    expect("policy" in res).toBe(true);
    if ("policy" in res) {
      expect(res.policy.status).toBe("resolved");
      // STUB mode's jury vote is deterministic given no LLM key — both the free verifier and the forced
      // panel apply the same numeric/NLI floor to the same obviously-contradicted claim, so they agree.
      expect(res.policy.juryVerdict).toBe(res.policy.originalVerdict);
      expect(res.policy.outcome).toBe("released");
      expect(res.policy.juryCertificateId).toBeTruthy();
    }
  });

  it("404s an unknown policy and 409s a re-resolve", async () => {
    const r404 = await insurance.resolvePolicy("nope");
    expect("error" in r404 && r404.status).toBe(404);
    const created = await insurance.createPolicy({ claim: "X was $9 trillion.", source: "X was $1 trillion.", coverageUsdc: 0.1, premiumUsdc: 0.01 });
    if (!("policy" in created)) throw new Error("create failed");
    await insurance.resolvePolicy(created.policy.id);
    const again = await insurance.resolvePolicy(created.policy.id);
    expect("error" in again && again.status).toBe(409);
  });

  it("tracks stats (total / open / resolved / paid / coverage outstanding)", () => {
    const s = insurance.insuranceStats();
    expect(s.total).toBeGreaterThan(0);
    expect(s.resolved).toBeGreaterThan(0);
    expect(s.coverageOutstandingUsdc).toBeGreaterThanOrEqual(0);
  });

  it("is off-chain when INSURANCE_ONCHAIN is unset", () => {
    expect(insurance.insuranceOnchainEnabled()).toBe(false);
  });
});
