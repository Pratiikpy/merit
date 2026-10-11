/**
 * Agentic insurance (Merit #17 / Hub feature) — a guarantee market on Merit's OWN verdicts.
 *
 * Arc's own Request for Builders names this explicitly: "underwrite the risks of autonomous agents...
 * with parametric payouts on verified loss events." Merit's loss event is specific and already has a
 * machine oracle: a citation verdict decided by the free three-gate verifier, later OVERTURNED by the
 * paid, diverse-panel jury. That disagreement — not a human claims adjuster — is the "verified loss
 * event" that triggers payout. Parametric by construction: no one rules on the claim; the stronger
 * re-check either agrees or it doesn't.
 *
 * Mechanics mirror `lib/market.ts` deliberately (same on-chain-gated, graceful-degrade shape, same
 * persisted-doc pattern) because the two features ARE the same shape: Merit's own verification engine
 * is the oracle both contracts are deployed to trust.
 *
 *   1. createPolicy    run the FREE verifier on (claim, source) — that verdict is what gets insured.
 *                       Bind a policy on-chain: Merit's BUYER wallet pays `premium`, reserving `coverage`
 *                       from Merit's own OPERATOR-underwritten pool. Self-funded on both sides, like the
 *                       market's self-seeded stake — provable with real money, no third-party wallet.
 *   2. resolvePolicy   re-check the SAME (claim, source) with the PAID jury panel (forcePanel: true —
 *                       a real diverse re-vote, not the free shortcut). If the jury's verdict disagrees
 *                       with the original, the original verdict was wrong: `claimValid = true`, coverage
 *                       pays out. If it agrees, the reservation releases back to the pool.
 *
 * On-chain against the deployed Insurance.sol (arbiter = OPERATOR, matching the constructor it was
 * deployed with); gated by INSURANCE_ONCHAIN=1 + keys + a configured address for this network + !stub,
 * else resolution still happens at the app level by the same two verdicts. Honesty: an on-chain tx is
 * recorded only when it actually lands.
 */
import { createWalletClient, createPublicClient, http, parseAbi, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { ARC, isStub, round6, arcChain } from "./arc";
import { serialize } from "./locks";
import { verifyCitation, isVerifyError } from "./verify/engine";
import { runJury } from "./jury";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

const INSURANCE_ABI = parseAbi([
  "function deposit(uint256 amount)",
  "function bind(bytes32 policyId, address underwriter, uint256 premium, uint256 coverage)",
  "function resolve(bytes32 policyId, bool claimValid)",
  "function withdraw(uint256 amount)",
  "function poolOf(address) view returns (uint256)",
  "function reservedOf(address) view returns (uint256)",
  "function policies(bytes32) view returns (address buyer, address underwriter, uint256 premium, uint256 coverage, uint8 state)",
]);
const USDC_APPROVE = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/** The deployed Insurance contract, from INSURANCE_ADDRESS — never a hard-coded fallback. Same reasoning
 *  as lib/market.ts's requireMarketAddress(): a wrong-network address would silently misroute real USDC. */
function insuranceAddress(): `0x${string}` | null {
  const a = process.env.INSURANCE_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : null;
}
function requireInsuranceAddress(): `0x${string}` {
  const a = insuranceAddress();
  if (!a) throw new Error("INSURANCE_ADDRESS is not configured for this network");
  return a;
}

/** On-chain policy ops are active with the flag + BOTH buyer (BUYER) and underwriter/arbiter (OPERATOR)
 *  keys + a configured address for this network, not STUB. */
export function insuranceOnchainEnabled(): boolean {
  return (
    process.env.INSURANCE_ONCHAIN === "1" &&
    !!process.env.BUYER_PRIVATE_KEY &&
    !!process.env.OPERATOR_PRIVATE_KEY &&
    !!insuranceAddress() &&
    !isStub()
  );
}

/** Coverage is capped low — this is a real-money proof of a mechanism, not a sized insurance product.
 *  Override with MERIT_INSURANCE_MAX_USDC once real underwriting capacity backs it. */
const MAX_COVERAGE_USDC = Math.max(0.01, Number(process.env.MERIT_INSURANCE_MAX_USDC) || 1);

const transport = () => http(ARC.rpcUrl);
const pub = () => createPublicClient({ chain: arcChain(), transport: transport() });
function signer(envKey: string) {
  const account = privateKeyToAccount(process.env[envKey] as `0x${string}`);
  return { account, wallet: createWalletClient({ account, chain: arcChain(), transport: transport() }) };
}
const explorerTx = (h: string) => `${ARC.explorer}/tx/${h}`;
const explorerAddr = (a: string) => `${ARC.explorer}/address/${a}`;

export interface Policy {
  id: string;
  policyId: `0x${string}`;
  claim: string;
  source?: string; // INTERNAL: full text the jury re-checks against — stripped from API reads
  sourcePreview: string;
  sourceHash: `0x${string}`;
  premiumUsdc: number;
  coverageUsdc: number;
  underwriter: string;
  buyer: string;
  originalVerdict: "SUPPORTED" | "REFUSED";
  originalVerificationId?: string;
  originalReason?: string;
  status: "open" | "resolved";
  outcome?: "paid" | "released"; // paid = the free verdict was overturned on appeal; released = it held
  juryVerdict?: "SUPPORTED" | "REFUSED";
  juryCertificateId?: string;
  juryReason?: string;
  txs?: Array<{ step: string; hash: string; explorerUrl: string }>;
  createdAt: string;
  resolvedAt?: string;
}
interface InsuranceLog {
  policies: Policy[];
}

const DOC = "insurance";
const MAX = 500;
let cache: InsuranceLog | null = null;
function load(): InsuranceLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<InsuranceLog>(DOC, { policies: [] });
  if (!value.policies) value.policies = [];
  if (cacheable) cache = value;
  return value;
}
export async function refreshInsuranceFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<InsuranceLog>(DOC);
  if (v && Array.isArray(v.policies)) cache = v;
}
function persist(log: InsuranceLog): void {
  cache = log;
  saveDoc(DOC, log);
}
function newId(): string {
  return BigInt("0x" + randomBytes(8).toString("hex")).toString(36).slice(0, 11);
}

/** Strip the full source from a policy before it leaves the module — API reads expose only the preview. */
function sanitize(p: Policy): Policy {
  const { source: _s, ...rest } = p;
  return rest;
}
function rawPolicy(id: string): Policy | undefined {
  return id ? load().policies.find((p) => p.id === id) : undefined;
}

export function getPolicy(id: string): Policy | undefined {
  const p = rawPolicy(id);
  return p ? sanitize(p) : undefined;
}
export function listPolicies(limit = 40): Policy[] {
  const p = load().policies;
  return p.slice(Math.max(0, p.length - limit)).reverse().map(sanitize);
}
export function insuranceStats(): { total: number; open: number; resolved: number; paid: number; coveragePaidUsdc: number; coverageOutstandingUsdc: number } {
  const p = load().policies;
  const resolved = p.filter((x) => x.status === "resolved");
  const paid = resolved.filter((x) => x.outcome === "paid");
  const open = p.filter((x) => x.status === "open");
  return {
    total: p.length,
    open: open.length,
    resolved: resolved.length,
    paid: paid.length,
    coveragePaidUsdc: round6(paid.reduce((s, x) => s + x.coverageUsdc, 0)),
    coverageOutstandingUsdc: round6(open.reduce((s, x) => s + x.coverageUsdc, 0)),
  };
}

/** Read the underwriter's free + reserved pool, for the stats page. Null off-chain. */
export async function readUnderwriterPool(underwriter: string): Promise<{ free: number; reserved: number } | null> {
  if (!insuranceOnchainEnabled()) return null;
  try {
    const [free, reserved] = await Promise.all([
      pub().readContract({ address: requireInsuranceAddress(), abi: INSURANCE_ABI, functionName: "poolOf", args: [underwriter as `0x${string}`] }) as Promise<bigint>,
      pub().readContract({ address: requireInsuranceAddress(), abi: INSURANCE_ABI, functionName: "reservedOf", args: [underwriter as `0x${string}`] }) as Promise<bigint>,
    ]);
    return { free: round6(Number(free) / 1e6), reserved: round6(Number(reserved) / 1e6) };
  } catch {
    return null;
  }
}

/** Admin op: the underwriter (Merit's OPERATOR wallet) deposits its own USDC into its own free pool, so
 *  policies have real capacity to bind against. Mirrors the market's self-seeded stake — Merit backing
 *  its own mechanism with its own money, not a third party's. */
export async function depositUnderwriterPool(amountUsdc: number): Promise<{ hash: string; explorerUrl: string } | { error: string; status: number }> {
  if (!insuranceOnchainEnabled()) return { error: "on-chain insurance is not enabled on this deployment", status: 409 };
  const amount = round6(Math.max(0, Number(amountUsdc) || 0));
  if (amount <= 0) return { error: "amountUsdc must be > 0", status: 400 };
  try {
    const op = signer("OPERATOR_PRIVATE_KEY");
    const atomic = BigInt(Math.round(amount * 1e6));
    const approveHash = await serialize("operator", () =>
      op.wallet.writeContract({ address: ARC.usdc as `0x${string}`, abi: USDC_APPROVE, functionName: "approve", args: [requireInsuranceAddress(), atomic], account: op.account, chain: arcChain() }),
    );
    await pub().waitForTransactionReceipt({ hash: approveHash });
    const depositHash = await serialize("operator", () =>
      op.wallet.writeContract({ address: requireInsuranceAddress(), abi: INSURANCE_ABI, functionName: "deposit", args: [atomic], account: op.account, chain: arcChain() }),
    );
    await pub().waitForTransactionReceipt({ hash: depositHash });
    return { hash: depositHash, explorerUrl: explorerTx(depositHash) };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 200), status: 502 };
  }
}

export interface CreatePolicyInput {
  claim: string;
  source: string;
  coverageUsdc: number;
  premiumUsdc: number;
  /** False for an unauthenticated caller: the policy is still recorded (with its real coverage/premium
   *  numbers) but never attempts the on-chain bind, which would spend Merit's own premium and reserve its
   *  own pool. Defaults true — callers that already gate this themselves (tests, trusted scripts) see no
   *  change. This is NOT where coverage gets zeroed; zeroing the amount for an unauthenticated caller was
   *  the bug (it made the advertised off-chain path impossible to use at all). */
  allowOnchain?: boolean;
}

/**
 * Buy a policy on Merit's own verdict. Runs the free verifier on (claim, source) — that verdict is what's
 * being insured. When on-chain is enabled, Merit's BUYER wallet binds the policy against the OPERATOR's
 * underwriter pool (premium paid, coverage reserved); otherwise the policy is recorded off-chain and
 * still resolvable by the same two verdicts.
 */
export async function createPolicy(input: CreatePolicyInput): Promise<{ policy: Policy } | { error: string; status: number }> {
  const claim = (input.claim || "").trim();
  const source = (input.source || "").trim();
  if (!claim || !source) return { error: "provide { claim, source } — the claim to insure and the source it was checked against", status: 400 };
  if (claim.length > 4000 || source.length > 20000) return { error: "claim ≤ 4000, source ≤ 20000 chars", status: 400 };
  const coverageUsdc = round6(Number(input.coverageUsdc) || 0);
  const premiumUsdc = round6(Number(input.premiumUsdc) || 0);
  if (coverageUsdc <= 0) return { error: "coverageUsdc must be > 0", status: 400 };
  if (coverageUsdc > MAX_COVERAGE_USDC) return { error: `coverageUsdc ≤ ${MAX_COVERAGE_USDC} USDC on this deployment`, status: 400 };
  if (premiumUsdc < 0 || premiumUsdc > coverageUsdc) return { error: "premiumUsdc must be between 0 and coverageUsdc", status: 400 };

  // The verdict being insured: the FREE three-gate verifier, the same oracle every other Merit surface uses.
  const checked = await verifyCitation(claim, source, {});
  if (isVerifyError(checked)) return { error: `could not establish the verdict to insure: ${checked.error}`, status: checked.status };
  const original = checked.verdict;

  const sourceHash = keccak256(toHex(source));
  const policyId = keccak256(toHex(`merit:policy:${claim}:${sourceHash}:${randomBytes(8).toString("hex")}`));

  const policy: Policy = {
    id: newId(),
    policyId,
    claim,
    source,
    sourcePreview: source.slice(0, 600),
    sourceHash,
    premiumUsdc,
    coverageUsdc,
    underwriter: process.env.OPERATOR_ADDRESS || "",
    buyer: process.env.BUYER_ADDRESS || "",
    originalVerdict: original.verdict,
    originalVerificationId: original.verificationId,
    originalReason: original.reason,
    status: "open",
    createdAt: new Date().toISOString(),
    txs: [],
  };

  if (insuranceOnchainEnabled() && input.allowOnchain !== false) {
    try {
      const buyer = signer("BUYER_PRIVATE_KEY");
      const underwriter = process.env.OPERATOR_ADDRESS as `0x${string}`;
      const premiumAtomic = BigInt(Math.round(premiumUsdc * 1e6));
      const coverageAtomic = BigInt(Math.round(coverageUsdc * 1e6));
      if (premiumAtomic > BigInt(0)) {
        const approveHash = await serialize("buyer", () =>
          buyer.wallet.writeContract({ address: ARC.usdc as `0x${string}`, abi: USDC_APPROVE, functionName: "approve", args: [requireInsuranceAddress(), premiumAtomic], account: buyer.account, chain: arcChain() }),
        );
        await pub().waitForTransactionReceipt({ hash: approveHash });
      }
      const bindHash = await serialize("buyer", () =>
        buyer.wallet.writeContract({ address: requireInsuranceAddress(), abi: INSURANCE_ABI, functionName: "bind", args: [policyId, underwriter, premiumAtomic, coverageAtomic], account: buyer.account, chain: arcChain() }),
      );
      await pub().waitForTransactionReceipt({ hash: bindHash });
      policy.txs!.push({ step: "bind", hash: bindHash, explorerUrl: explorerTx(bindHash) });
    } catch (e) {
      policy.txs!.push({ step: "bind-failed", hash: "", explorerUrl: "" });
      console.error("[insurance] on-chain bind failed (policy still recorded off-chain):", (e as Error).message);
    }
  }

  const log = load();
  log.policies.push(policy);
  if (log.policies.length > MAX) log.policies = log.policies.slice(-MAX);
  persist(log);
  return { policy: sanitize(policy) };
}

/**
 * Resolve a policy by re-checking the SAME (claim, source) with the PAID jury panel (a real diverse
 * re-vote, forcePanel: true). The "verified loss event" is the jury DISAGREEING with the original free
 * verdict — that disagreement is claimValid, and coverage pays the buyer. Agreement releases the
 * reservation. When on-chain, the OPERATOR (the contract's fixed arbiter) calls resolve(). Never throws.
 */
export async function resolvePolicy(id: string): Promise<{ policy: Policy } | { error: string; status: number }> {
  const policy = rawPolicy(id);
  if (!policy) return { error: "policy not found", status: 404 };
  if (policy.status !== "open") return { error: "policy already resolved", status: 409 };

  const cert = await runJury({ claim: policy.claim, source: policy.source || policy.sourcePreview, amount: policy.coverageUsdc, forcePanel: true, sign: true });
  if (!cert.ok) return { error: `jury could not re-check this policy: ${cert.error}`, status: cert.status };
  const juryClaim = cert.certificate.claims[0];
  if (!juryClaim) return { error: "jury returned no claim result", status: 502 };

  const claimValid = juryClaim.verdict !== policy.originalVerdict; // the appeal overturned the original call
  policy.juryVerdict = juryClaim.verdict;
  policy.juryCertificateId = cert.certificate.certificateId;
  policy.juryReason = juryClaim.reason;
  policy.outcome = claimValid ? "paid" : "released";
  policy.status = "resolved";
  policy.resolvedAt = new Date().toISOString();

  if (insuranceOnchainEnabled()) {
    try {
      const arbiter = signer("OPERATOR_PRIVATE_KEY"); // the contract's fixed arbiter = OPERATOR_ADDRESS
      const resolveHash = await serialize("operator", () =>
        arbiter.wallet.writeContract({ address: requireInsuranceAddress(), abi: INSURANCE_ABI, functionName: "resolve", args: [policy.policyId, claimValid], account: arbiter.account, chain: arcChain() }),
      );
      await pub().waitForTransactionReceipt({ hash: resolveHash });
      policy.txs = policy.txs || [];
      policy.txs.push({ step: `resolve(${policy.outcome})`, hash: resolveHash, explorerUrl: explorerTx(resolveHash) });
    } catch (e) {
      console.error("[insurance] on-chain resolve failed (resolved at app level by the same verdicts):", (e as Error).message);
    }
  }

  persist(load());
  return { policy: sanitize(policy) };
}

export { explorerAddr };
