/**
 * ERC-8004 on-chain identity, reputation, AND validation (best-effort) — all THREE canonical Arc
 * registries. Two roles, because the registries reject self-attestation:
 *   - registrar/owner  = OPERATOR wallet → mints agent identities (IdentityRegistry.register) and
 *                        opens validation requests (ValidationRegistry.validationRequest)
 *   - validator        = BUYER wallet (the Merit agent / Auditor) → rates the creators it used
 *                        (ReputationRegistry.giveFeedback) and records the proof-of-citation verdict
 *                        (ValidationRegistry.validationResponse, 0-100)
 * Owner ≠ validator, so neither feedback nor validation reverts as a self-rating.
 *
 * On-chain writes are gated by REPUTATION_ONCHAIN=1 (default off — merit is also
 * cached in the file registry). Failures are logged and returned as null; they
 * never break a run. ABI verified against Arc docs AND a live testnet write: register(string) emits
 * ERC-721 Transfer; giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32);
 * validationRequest(address,uint256,string,bytes32) + validationResponse(bytes32,uint8,string,bytes32,string).
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  keccak256,
  toHex,
} from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, isStub, fakeTxHash } from "./arc";
import { serialize } from "./locks";
import { getPublisherAgentId, setPublisherAgentId } from "./registry";
import { randomBytes } from "node:crypto";

const REP_ABI = parseAbi([
  "function giveFeedback(uint256 agentId, int128 score, uint8 feedbackType, string tag, string metadataURI, string evidenceURI, string comment, bytes32 feedbackHash)",
]);
const ID_ABI = parseAbi(["function register(string metadataURI)"]);
// ERC-8004 ValidationRegistry (Arc): the OWNER opens a request naming a validator, the VALIDATOR then
// answers with a 0-100 response. Interface from the Arc "register your first AI agent" tutorial against
// the deployed ARC.validationRegistry address.
const VALIDATION_ABI = parseAbi([
  "function validationRequest(address validator, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
]);
// keccak of the ReputationRegistry feedback event (observed from a real tx); the
// indexed agentId is topic[1] and the int128 score is the 2nd word of log data.
const FEEDBACK_TOPIC = "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc";
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

function onchainEnabled(): boolean {
  return (
    process.env.REPUTATION_ONCHAIN === "1" &&
    !!process.env.OPERATOR_PRIVATE_KEY &&
    !!process.env.BUYER_PRIVATE_KEY &&
    !isStub()
  );
}

const transport = () => http(ARC.rpcUrl);
function pub() {
  return createPublicClient({ chain: arcTestnet, transport: transport() });
}
function registrar() {
  // OPERATOR mints + owns agent identities.
  const account = privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
  return { account, wallet: createWalletClient({ account, chain: arcTestnet, transport: transport() }) };
}
function validator() {
  // BUYER (the Merit agent) records feedback — distinct from the owner.
  const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
  return { account, wallet: createWalletClient({ account, chain: arcTestnet, transport: transport() }) };
}

const ID_OWNER_ABI = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);
/** True iff the OPERATOR still owns this agentId on-chain — the precondition for opening a
 *  validationRequest for it. A persisted id that is a STUB fake, was minted by a prior operator key,
 *  or was invalidated by a testnet registry reset will NOT resolve to the operator (ownerOf reverts or
 *  returns someone else) → false → the run drops it and re-mints a real, owned identity, instead of
 *  reverting "Not authorized" on every validation write. Read-only; conservative (any uncertainty → false). */
export async function operatorOwnsIdentity(agentId: string | undefined): Promise<boolean> {
  if (!agentId) return false;
  if (!onchainEnabled()) return true; // no live chain to validate against (STUB / off-chain) → trust the persisted id, don't force a needless re-mint
  try {
    const owner = (await pub().readContract({
      address: ARC.identityRegistry as `0x${string}`,
      abi: ID_OWNER_ABI,
      functionName: "ownerOf",
      args: [BigInt(agentId)],
    })) as string;
    return owner.toLowerCase() === registrar().account.address.toLowerCase();
  } catch {
    return false; // nonexistent/invalidated token (ownerOf reverts) or RPC hiccup → re-mint a fresh one
  }
}

/** Mint an ERC-8004 identity (operator-owned). Returns { agentId, txHash } or null. */
export async function registerIdentity(
  metadataURI: string,
): Promise<{ agentId: string; txHash: string } | null> {
  if (isStub()) return { agentId: String(Math.floor(Math.random() * 1e6)), txHash: fakeTxHash() };
  if (!onchainEnabled()) return null;
  try {
    const { account, wallet } = registrar();
    const p = pub();
    // Serialize on the operator EOA so concurrent runs don't collide on nonce.
    const tx = await serialize("operator", () =>
      wallet.writeContract({
        address: ARC.identityRegistry as `0x${string}`,
        abi: ID_ABI,
        functionName: "register",
        args: [metadataURI],
      }),
    );
    const receipt = await p.waitForTransactionReceipt({ hash: tx, timeout: 20_000 });
    // agentId = tokenId of the ERC-721 minted to the operator.
    const logs = await p.getLogs({
      address: ARC.identityRegistry as `0x${string}`,
      event: TRANSFER_EVENT,
      args: { to: account.address },
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    const agentId = logs.length ? (logs[logs.length - 1].args.tokenId as bigint).toString() : "";
    if (!agentId) {
      console.error("[reputation] registerIdentity: minted but could not parse tokenId from Transfer logs");
      return null;
    }
    return { agentId, txHash: tx };
  } catch (e) {
    console.error("[reputation] registerIdentity failed:", (e as Error).message);
    return null;
  }
}

/**
 * Discovered publishers share ONE on-chain identity per domain, so reputation
 * accrues to the publisher across its articles and runs instead of minting a
 * throwaway identity per article. Single-flight per domain; a failed mint is not
 * cached, so a later run retries. In-memory (per server session) — sufficient for
 * a demo, where the publisher accrues across the session's runs.
 */
const publisherIdentities = new Map<string, Promise<string | null>>();
export function ensurePublisherIdentity(domain: string): Promise<string | null> {
  let p = publisherIdentities.get(domain);
  if (!p) {
    p = (async () => {
      // Reuse a persisted identity if this publisher was minted in a prior session
      // (survives restarts), so reputation keeps accruing to the same identity.
      const persisted = getPublisherAgentId(domain);
      // Reuse only if the operator STILL owns it; a stale/foreign/reset-invalidated persisted id would
      // revert validationRequest "Not authorized" — so fall through and re-mint a real, owned one.
      if (persisted && (await operatorOwnsIdentity(persisted))) return persisted;
      const ident = await registerIdentity(`merit:publisher:${domain}`);
      const id = ident?.agentId ?? null;
      if (id) setPublisherAgentId(domain, id);
      return id;
    })();
    publisherIdentities.set(domain, p);
    p.then(
      (id) => {
        if (!id) publisherIdentities.delete(domain);
      },
      () => publisherIdentities.delete(domain),
    );
  }
  return p;
}

/** Record feedback for an agent, signed by the BUYER (validator). Returns tx hash or null. */
export async function giveFeedback(
  agentId: string | undefined,
  score: number,
  tag: string,
  evidenceURI = "",
): Promise<string | null> {
  if (isStub()) return fakeTxHash();
  if (!onchainEnabled() || !agentId) return null;
  try {
    const { wallet } = validator();
    const clamped = Math.max(-100, Math.min(100, Math.round(score)));
    // Serialize on the buyer EOA so concurrent runs don't collide on nonce.
    const tx = await serialize("buyer", () =>
      wallet.writeContract({
        address: ARC.reputationRegistry as `0x${string}`,
        abi: REP_ABI,
        functionName: "giveFeedback",
        args: [
          BigInt(agentId),
          BigInt(clamped),
          0, // feedbackType
          tag,
          "", // metadataURI
          evidenceURI,
          "", // comment
          keccak256(toHex(`merit:${agentId}:${clamped}:${tag}`)), // bind to this feedback, not a constant
        ],
      }),
    );
    return tx;
  } catch (e) {
    console.error("[reputation] giveFeedback failed:", (e as Error).message);
    return null;
  }
}

/**
 * Record the Auditor's proof-of-citation verdict on Arc's CANONICAL ERC-8004 ValidationRegistry — the
 * third registry, alongside Identity + Reputation. The OPERATOR (agent owner) opens a validationRequest
 * naming the BUYER (the Auditor) as validator; the BUYER then submits the validationResponse with a
 * 0-100 support score (100 = the source supported the claim, 0 = refuted/unclear). Two steps + two
 * wallets per ERC-8004 anti-self-dealing; the request must be mined before the response or it reverts.
 * Returns the response tx (the verdict on-chain) or null. Best-effort, REPUTATION_ONCHAIN-gated,
 * STUB-safe — never breaks a run.
 */
export async function validateCitation(
  agentId: string | undefined,
  response: number,
  tag: string,
  responseURI = "",
): Promise<string | null> {
  if (isStub()) return fakeTxHash();
  if (!onchainEnabled() || !agentId) return null;
  try {
    const { wallet: ownerWallet } = registrar();
    const { account: valAccount, wallet: valWallet } = validator();
    const p = pub();
    const resp = Math.max(0, Math.min(100, Math.round(response)));
    // Unique join key per validation so no two requests collide on the same hash — the random entropy
    // guards concurrent runs on a SHARED publisher identity (same agentId+verdict+tag within one ms).
    const requestHash = keccak256(toHex(`merit:val:${agentId}:${resp}:${tag}:${Date.now()}:${randomBytes(16).toString("hex")}`));
    // 1) Owner opens the request, naming the BUYER (the Auditor) as the validator.
    const reqTx = await serialize("operator", () =>
      ownerWallet.writeContract({
        address: ARC.validationRegistry as `0x${string}`,
        abi: VALIDATION_ABI,
        functionName: "validationRequest",
        args: [valAccount.address, BigInt(agentId), "", requestHash],
      }),
    );
    // Bounded wait (vs viem's 180s default) so a stuck request can't blow the run's maxDuration; and a
    // reverted request must NOT proceed to a response against an unregistered hash (which would surface a
    // reverted tx as the verdict link). response reverts if the request isn't mined yet, hence the wait.
    const reqRcpt = await p.waitForTransactionReceipt({ hash: reqTx, timeout: 20_000 });
    if (reqRcpt.status !== "success") throw new Error("validationRequest reverted");
    // 2) Validator (the Auditor) submits the verdict as the validation response.
    const resTx = await serialize("buyer", () =>
      valWallet.writeContract({
        address: ARC.validationRegistry as `0x${string}`,
        abi: VALIDATION_ABI,
        functionName: "validationResponse",
        args: [requestHash, resp, responseURI, `0x${"0".repeat(64)}` as `0x${string}`, tag],
      }),
    );
    // Symmetric guard: confirm the verdict tx itself succeeded — a mined-but-reverted response would
    // otherwise be returned as the verdict link and read back as the unset default (REFUTED) for a PAID
    // source. On revert/timeout, throw → the caller returns null → no validationUrl is recorded.
    const resRcpt = await p.waitForTransactionReceipt({ hash: resTx, timeout: 20_000 });
    if (resRcpt.status !== "success") throw new Error("validationResponse reverted");
    return resTx;
  } catch (e) {
    console.error("[reputation] validateCitation failed:", (e as Error).message);
    return null;
  }
}

/** One on-chain feedback event — a single release/refuse a validator wrote, independently
 *  verifiable on Arc (click the explorerUrl). The agent's portable track record is the list. */
export interface FeedbackEvent {
  score: number; // +N for a release, −N for a refuse (the validator's rating)
  block: number;
  tx: string;
  explorerUrl: string;
}

export interface OnchainReputation {
  count: number;
  sum: number;
  average: number;
  scores: number[];
  feedback: FeedbackEvent[]; // the verifiable timeline (most recent ~9k blocks)
}

/**
 * Read an agent's reputation directly from the ReputationRegistry by decoding
 * giveFeedback events — so the score is genuinely recomputed from chain, not the
 * local cache. The RPC caps eth_getLogs at a 10k-block range, so this covers the
 * recent window (more than enough to verify a live demo's feedback). Null in stub
 * or on error.
 */
/** Decode the int128 feedback score from a giveFeedback event's log data: the 2nd 32-byte word,
 *  sign-extended (positive = a release, negative = a refuse). Empirically located from a real Arc
 *  tx; exported so this subtle, money-relevant decode is unit-tested against regression. */
export function decodeFeedbackScore(data: string): number {
  return Number(BigInt.asIntN(256, BigInt("0x" + data.slice(2 + 64, 2 + 128))));
}

export async function readOnchainReputation(
  agentId: string | undefined,
  windowBlocks = 9000,
): Promise<OnchainReputation | null> {
  if (isStub() || !agentId) return null;
  try {
    const p = pub();
    const head = await p.getBlockNumber();
    const from = head > BigInt(windowBlocks) ? head - BigInt(windowBlocks) : BigInt(0);
    const agentTopic = ("0x" + BigInt(agentId).toString(16).padStart(64, "0")) as `0x${string}`;
    const logs = (await p.request({
      method: "eth_getLogs",
      params: [
        {
          address: ARC.reputationRegistry as `0x${string}`,
          topics: [FEEDBACK_TOPIC, agentTopic],
          fromBlock: ("0x" + from.toString(16)) as `0x${string}`,
          toBlock: ("0x" + head.toString(16)) as `0x${string}`,
        },
      ],
    } as never)) as Array<{ data: string; blockNumber: string; transactionHash: string }>;
    // int128 score = the 2nd 32-byte word of the (non-indexed) log data, sign-extended. Build the
    // per-event timeline too — each feedback is its own on-chain tx, verifiable on arcscan.
    const feedback: FeedbackEvent[] = logs.map((l) => ({
      score: decodeFeedbackScore(l.data),
      block: Number(BigInt(l.blockNumber)),
      tx: l.transactionHash,
      explorerUrl: `${ARC.explorer}/tx/${l.transactionHash}`,
    }));
    const scores = feedback.map((f) => f.score);
    const sum = scores.reduce((a, b) => a + b, 0);
    return { count: scores.length, sum, average: scores.length ? sum / scores.length : 0, scores, feedback };
  } catch (e) {
    console.error("[reputation] readOnchainReputation failed:", (e as Error).message);
    return null;
  }
}
