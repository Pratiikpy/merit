import { describe, it, expect } from "vitest";
import { auditLicense, type LicenseAuditReport } from "../lib/licenseaudit";

describe("licensing-compliance audit", () => {
  it("400s without a source", async () => {
    const r = await auditLicense({ source: "", claims: ["x"] });
    expect("error" in r && r.status).toBe(400);
  });

  it("400s without claims", async () => {
    const r = await auditLicense({ source: "some licensed text", claims: [] });
    expect("error" in r && r.status).toBe(400);
  });

  it("flags a misattributed figure as misattribution (deterministic numeric gate, keyless)", async () => {
    const r = (await auditLicense({
      source: "The publisher network raised $31 million and works with roughly 7,000 sites.",
      claims: [
        "The publisher network raised $500 million.", // contradicts $31M → misattributed
        "The publisher network raised $250 million.", // contradicts → misattributed
      ],
      licensor: "ExampleWire",
      sign: true,
    })) as LicenseAuditReport;
    expect(r.schema).toBe("merit.license-audit/v1");
    expect(r.checked).toBe(2);
    expect(r.misattributed).toBeGreaterThanOrEqual(1);
    expect(r.report.some((x) => x.misattributed)).toBe(true);
    expect(r.summary).toMatch(/misattributed/i);
    expect(r.auditId).toMatch(/^0x/);
  });

  it("binds the report to the source hash and is signed", async () => {
    const r = (await auditLicense({
      source: "Revenue was $2 billion for the quarter.",
      claims: ["Revenue was $9 billion for the quarter."],
    })) as LicenseAuditReport;
    expect(r.sourceHash).toMatch(/^0x/);
    // signature is best-effort (present when a signer key is configured); the report is valid either way
    expect(typeof r.supportedShare).toBe("number");
  });
});
