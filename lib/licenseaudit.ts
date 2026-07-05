/**
 * Licensing-compliance audit (cat 6/7 — the standalone upsell for content licensors). Bulk AI-licensing deals
 * (OpenAI / Meta with publishers) have no mechanism to check the licensee is citing the licensed content
 * correctly and proportionally to the deal terms. This samples the claims in an AI output against the licensed
 * source and flags MISATTRIBUTION — claims that credit the source but the source does not actually support —
 * producing a signed report a licensor can act on for a royalty true-up. Reuses the same verifyCitation gate as
 * every other Merit door; one core, another artifact.
 *
 * POST /api/license/audit { source, claims: string[], licensor? }
 *   → { checked, supported, misattributed, supportedShare, report[], signer, signature }
 */
import { keccak256, toHex } from "viem";
import { verifyCitation, isVerifyError } from "./verify/engine";
import { signReceipt, verificationId } from "./receipt";

const MAX_CLAIMS = 10;
const MAX_SOURCE = 20000;

export interface AuditedClaim {
  claim: string;
  verdict: "SUPPORTED" | "REFUSED" | "ERROR";
  misattributed: boolean; // REFUSED = credited to the licensed source but not supported by it
  reason: string;
  verificationId?: string;
}

export interface LicenseAuditReport {
  schema: "merit.license-audit/v1";
  licensor?: string;
  sourceHash: `0x${string}`;
  checked: number;
  supported: number;
  misattributed: number;
  errored: number;
  supportedShare: number; // fraction of checkable claims the source genuinely supports
  report: AuditedClaim[];
  summary: string;
  auditedAt: string;
  signer?: string;
  signature?: string;
  auditId?: `0x${string}`;
}

export interface AuditError {
  error: string;
  status: number;
}

/** Audit each claim against the licensed source; flag the ones the source does not support as misattribution. */
export async function auditLicense(input: { source: string; claims: string[]; licensor?: string; sign?: boolean }): Promise<LicenseAuditReport | AuditError> {
  const source = (input.source || "").trim();
  const claims = (input.claims || [])
    .map((c) => (c || "").trim())
    .filter(Boolean)
    .slice(0, MAX_CLAIMS);
  if (!source) return { error: "provide the licensed { source } text", status: 400 };
  if (source.length > MAX_SOURCE) return { error: `source ≤ ${MAX_SOURCE} chars`, status: 400 };
  if (!claims.length) return { error: "provide { claims } — the assertions in the AI output that credit this source", status: 400 };

  const report: AuditedClaim[] = [];
  // Sequential to respect the judge rate limit; each claim faces the full three-gate verifier.
  for (const claim of claims) {
    const outcome = await verifyCitation(claim, source, {});
    if (isVerifyError(outcome)) {
      report.push({ claim, verdict: "ERROR", misattributed: false, reason: outcome.error });
      continue;
    }
    const v = outcome.verdict;
    report.push({
      claim,
      verdict: v.verdict,
      misattributed: v.verdict === "REFUSED",
      reason: v.reason,
      verificationId: v.verificationId,
    });
  }

  const checkable = report.filter((r) => r.verdict !== "ERROR");
  const supported = checkable.filter((r) => r.verdict === "SUPPORTED").length;
  const misattributed = checkable.filter((r) => r.verdict === "REFUSED").length;
  const errored = report.length - checkable.length;
  const supportedShare = checkable.length ? Math.round((supported / checkable.length) * 1000) / 1000 : 0;

  const body: LicenseAuditReport = {
    schema: "merit.license-audit/v1",
    licensor: input.licensor ? input.licensor.slice(0, 80) : undefined,
    sourceHash: keccak256(toHex(source)),
    checked: report.length,
    supported,
    misattributed,
    errored,
    supportedShare,
    report,
    summary:
      misattributed > 0
        ? `${misattributed} of ${checkable.length} checkable claims are misattributed — credited to the licensed source but not supported by it. Basis for a royalty true-up or takedown.`
        : `All ${checkable.length} checkable claims are genuinely supported by the licensed source. No misattribution found.`,
    auditedAt: new Date().toISOString(),
  };

  if (input.sign !== false) {
    try {
      const sig = await signReceipt(body);
      if (sig) Object.assign(body, sig);
    } catch {
      /* signing is best-effort */
    }
  }
  body.auditId = verificationId(body);
  return body;
}
