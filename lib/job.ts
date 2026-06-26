/**
 * Hook-gated ERC-8183 settlement (the connected moat) — drives MeritJob + MeritVerificationHook ON-CHAIN so
 * a real run's escrow release is gated by the proof-of-citation verdict, not just asserted.
 *
 * Flow (roles use Merit's three keys): client(BUYER) creates + funds a MeritJob escrow, provider(SELLER) sets
 * the budget + submits the answer hash, the validator(OPERATOR) records the verdict via the hook, then the
 * evaluator(OPERATOR) calls complete() — which the hook REVERTS when the citation did not verify. On a fail
 * we prove the gate by simulating complete() (it reverts with NotVerified) and then reject() to refund. The
 * Gateway path (lib/pay.ts) remains the funding spine that actually pays each source; this binds the on-chain
 * RELEASE DECISION to proof-of-citation. Gated: inactive unless MERIT_HOOK_ONCHAIN=1 + the three keys + both
 * deployed addresses + not STUB — so the default run is byte-identical and never depends on the contracts.
 */
import { createWalletClient, createPublicClient, http, parseAbi, keccak256, toHex, decodeEventLog } from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, isStub } from "./arc";

const JOB_ABI = parseAbi([
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256)",
  "function setBudget(uint256 jobId, uint256 amount, bytes optParams)",
  "function fund(uint256 jobId, bytes optParams)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function complete(uint256 jobId, bytes32 reason, bytes optParams)",
  "function reject(uint256 jobId, bytes32 reason, bytes optParams)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
]);
const HOOK_ABI = parseAbi(["function recordVerdict(address host, uint256 jobId, bool verified, bytes32 proofHash)"]);
const USDC_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

function envAddr(name: string): `0x${string}` | undefined {
  const a = process.env[name];
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : undefined;
}
export const meritJobAddress = () => envAddr("MERITJOB_ADDRESS");
export const meritHookAddress = () => envAddr("MERIT_HOOK_ADDRESS");

/** The hook-gated settlement is active only with the flag, all three keys, both deployed addresses, not STUB. */
export function jobHookEnabled(): boolean {
  return (
    process.env.MERIT_HOOK_ONCHAIN === "1" &&
    !!process.env.BUYER_PRIVATE_KEY &&
    !!process.env.OPERATOR_PRIVATE_KEY &&
    !!meritJobAddress() &&
    !!meritHookAddress() &&
    !isStub()
  );
}

const transport = () => http(ARC.rpcUrl);
const pub = () => createPublicClient({ chain: arcTestnet, transport: transport() });
function signer(envKey: string) {
  const account = privateKeyToAccount(process.env[envKey] as `0x${string}`);
  return { account, wallet: createWalletClient({ account, chain: arcTestnet, transport: transport() }) };
}

export interface HookGateResult {
  jobId: string;
  outcome: "released" | "gate-reverted-then-refunded";
  verified: boolean;
  proofHash: string;
  txs: Array<{ step: string; hash: string }>;
  job: string;
  explorer: string;
}

/** Run the full hook-gated ERC-8183 lifecycle on-chain. On `verified`, complete() releases the escrow; else
 *  the hook reverts complete() (proven by simulation) and reject() refunds. Returns the on-chain trail, or
 *  null when the gate isn't enabled (default). Never throws into a run. */
export async function settleViaHook(opts: {
  amountAtomic: bigint;
  verified: boolean;
  deliverableHash: `0x${string}`;
  proofHash: `0x${string}`;
  description?: string;
}): Promise<HookGateResult | null> {
  if (!jobHookEnabled()) return null;
  const job = meritJobAddress()!;
  const hook = meritHookAddress()!;
  const client = signer("BUYER_PRIVATE_KEY");
  const provider = client; // BUYER is also the provider here (only BUYER/OPERATOR are confirmed gas-funded); the hook gates complete() regardless of payee
  const evaluator = signer("OPERATOR_PRIVATE_KEY"); // also the validator that records the verdict
  const txs: Array<{ step: string; hash: string }> = [];
  const send = async (
    s: ReturnType<typeof signer>,
    address: `0x${string}`,
    abi: typeof JOB_ABI | typeof HOOK_ABI | typeof USDC_ABI,
    functionName: string,
    args: readonly unknown[],
    step: string,
  ) => {
    // viem infers functionName as the ABI's union; this helper is generic over 3 ABIs, so cast the
    // discriminating fields (same pattern as lib/escrow.ts). The callers below pass matching shapes.
    const hash = await s.wallet.writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, account: s.account, chain: arcTestnet });
    txs.push({ step, hash });
    await pub().waitForTransactionReceipt({ hash });
    return hash;
  };
  let fundedJobId: bigint | undefined; // set once escrow holds funds → any later failure must refund (cleanup below)
  let submitted = false;
  try {
    const block = await pub().getBlock();
    const expiredAt = block.timestamp + BigInt(3600);
    // 1. client creates the job (naming the hook + the evaluator)
    const createHash = await client.wallet.writeContract({
      address: job, abi: JOB_ABI, functionName: "createJob",
      args: [provider.account.address, evaluator.account.address, expiredAt, opts.description || "merit proof-of-citation settlement", hook],
      account: client.account, chain: arcTestnet,
    });
    txs.push({ step: "createJob", hash: createHash });
    const rcpt = await pub().waitForTransactionReceipt({ hash: createHash });
    let jobId: bigint | undefined;
    for (const log of rcpt.logs) {
      try {
        const d = decodeEventLog({ abi: JOB_ABI, data: log.data, topics: log.topics });
        if (d.eventName === "JobCreated") { jobId = (d.args as { jobId: bigint }).jobId; break; }
      } catch {
        /* not our event */
      }
    }
    if (jobId === undefined) throw new Error("JobCreated not parsed");
    // 2-4. provider prices it, client funds escrow, provider submits the deliverable hash
    await send(provider, job, JOB_ABI, "setBudget", [jobId, opts.amountAtomic, "0x"], "setBudget");
    await send(client, ARC.usdc as `0x${string}`, USDC_ABI, "approve", [job, opts.amountAtomic], "approveUSDC");
    await send(client, job, JOB_ABI, "fund", [jobId, "0x"], "fund(escrow)");
    fundedJobId = jobId; // escrow now funded — a failure past this point triggers the refund cleanup
    await send(provider, job, JOB_ABI, "submit", [jobId, opts.deliverableHash, "0x"], "submit(deliverable)");
    submitted = true;
    // 5. the validator records the proof-of-citation verdict on the hook
    await send(evaluator, hook, HOOK_ABI, "recordVerdict", [job, jobId, opts.verified, opts.proofHash], "recordVerdict");
    // 6. the evaluator completes — the hook GATES the release on the verdict
    if (opts.verified) {
      await send(evaluator, job, JOB_ABI, "complete", [jobId, keccak256(toHex("citation-verified")), "0x"], "complete(release)");
      return { jobId: jobId.toString(), outcome: "released", verified: true, proofHash: opts.proofHash, txs, job, explorer: `${ARC.explorer}/address/${job}` };
    }
    // Failed citation: prove the gate by simulating complete() (reverts NotVerified) without wasting a tx,
    // then reject() to refund the client.
    let gateReverted = false;
    try {
      await pub().simulateContract({ address: job, abi: JOB_ABI, functionName: "complete", args: [jobId, keccak256(toHex("attempt")), "0x"], account: evaluator.account });
    } catch {
      gateReverted = true; // the hook's NotVerified() revert — proof the release is gated
    }
    await send(evaluator, job, JOB_ABI, "reject", [jobId, keccak256(toHex("citation-failed")), "0x"], "reject(refund)");
    if (!gateReverted) console.error("[job] WARNING: complete() did NOT revert on an unverified citation — gate not enforced");
    return { jobId: jobId.toString(), outcome: "gate-reverted-then-refunded", verified: false, proofHash: opts.proofHash, txs, job, explorer: `${ARC.explorer}/address/${job}` };
  } catch (e) {
    console.error("[job] hook-gated settlement failed:", (e as Error).message);
    // Best-effort cleanup: if escrow was already funded, refund it so funds aren't stranded. reject() needs
    // the Submitted state, so move a still-Funded job to Submitted first. If cleanup itself fails, the job's
    // expiredAt (now + 1h) claimRefund is the ultimate backstop — funds are never permanently lost.
    if (fundedJobId !== undefined) {
      try {
        if (!submitted) await send(provider, job, JOB_ABI, "submit", [fundedJobId, keccak256(toHex("cleanup")), "0x"], "cleanup-submit");
        await send(evaluator, job, JOB_ABI, "reject", [fundedJobId, keccak256(toHex("cleanup-refund")), "0x"], "cleanup-reject");
        console.error(`[job] partial failure — escrow refunded via cleanup (job ${fundedJobId})`);
      } catch (ce) {
        console.error("[job] cleanup-refund failed; escrow reclaimable via the expiry path:", (ce as Error).message);
      }
    }
    return null;
  }
}
