/**
 * Gasless USDC on Arc (EIP-3009) — funding Merit without ever holding gas.
 *
 * On Arc, gas is paid in USDC. That is elegant until you meet the cold start: to move USDC you must already
 * hold USDC on Arc, in the same wallet, at the moment you act. A buyer who holds USDC on another chain, or who
 * has just been sent exactly the amount they intend to spend, cannot open a Merit prepaid balance at all.
 *
 * EIP-3009 removes the requirement. The payer SIGNS a `TransferWithAuthorization` message off-chain — no
 * transaction, no gas, no nonce management — and Merit's relayer EOA broadcasts it and pays the gas from its
 * own USDC. The value still moves from the payer's account; only the gas is ours. This is the same primitive
 * x402 settles with, used here for the one flow where Arc's stablecoin-gas model bites hardest.
 *
 * Everything below was verified against Arc testnet, not assumed:
 *   - Arc USDC implements EIP-3009 (`authorizationState` reads; `DOMAIN_SEPARATOR` present)
 *   - the EIP-712 domain is exactly {name:"USDC", version:"2", chainId:5042002, verifyingContract:0x3600…}
 *     — recomputed locally and compared byte-for-byte against the contract's own DOMAIN_SEPARATOR
 *
 * Two guardrails come straight from Arc's own operator notes and are enforced here, not documented and hoped
 * for: an authorization that would fully drain a brand-new account (zero balance, zero nonce, no code) reverts
 * on Arc today, and a blocklisted `from`/`to` reverts at runtime and burns the relayer's gas for nothing. Both
 * are checked BEFORE broadcast, so a doomed relay costs no gas.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256, encodeAbiParameters, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, explorerTx, isStub, round6 } from "./arc";
import { assertPayeeCompliant } from "./compliance";

/** The EIP-712 domain Arc USDC signs under. Verified equal to the contract's own DOMAIN_SEPARATOR. */
export const USDC_EIP712_DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: ARC.chainId,
  verifyingContract: ARC.usdc as `0x${string}`,
} as const;

/** The typed-data struct a payer signs. `nonce` is a RANDOM bytes32 (not an account nonce) — it is the replay
 *  key, and `authorizationState(from, nonce)` on the token tells you whether it has already been used. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const EIP3009_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

/** Arc's minimum accepted `maxFeePerGas`. A transaction priced under this may sit pending forever. */
export const ARC_MIN_MAX_FEE_PER_GAS = BigInt(20_000_000_000); // 20 Gwei

export interface Authorization {
  from: string;
  to: string;
  /** atomic USDC (6 decimals), as a decimal string so it survives JSON without precision loss */
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signature: Hex;
}

function pub() {
  return createPublicClient({ transport: http(process.env.ARC_RPC_URL || ARC.rpcUrl) });
}

/** The relayer EOA — the wallet whose USDC pays the gas. Distinct env var so it can be funded and rotated
 *  independently of the settlement wallet; falls back to the buyer key for local development. */
function relayerKey(): string | undefined {
  return process.env.RELAYER_PRIVATE_KEY || process.env.BUYER_PRIVATE_KEY;
}
export function relayerConfigured(): boolean {
  return !!relayerKey() && !isStub();
}
export function relayerAddress(): string | null {
  const pk = relayerKey();
  if (!pk) return null;
  try {
    return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex).address;
  } catch {
    return null;
  }
}

/** Recompute the EIP-712 domain separator locally, so a caller can prove the domain we publish is the domain
 *  the token actually enforces rather than taking our word for it. */
export function computeDomainSeparator(): Hex {
  const typeHash = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        typeHash,
        keccak256(stringToHex(USDC_EIP712_DOMAIN.name)),
        keccak256(stringToHex(USDC_EIP712_DOMAIN.version)),
        BigInt(USDC_EIP712_DOMAIN.chainId),
        USDC_EIP712_DOMAIN.verifyingContract,
      ],
    ),
  );
}

/** Confirm the token on-chain enforces the domain we ask payers to sign under. A mismatch means every
 *  signature we collect would be rejected, so it is worth one read before relaying anything. */
export async function domainMatchesChain(): Promise<{ ok: boolean; local: Hex; onchain: Hex | null }> {
  const local = computeDomainSeparator();
  try {
    const onchain = (await pub().readContract({ address: ARC.usdc as `0x${string}`, abi: EIP3009_ABI, functionName: "DOMAIN_SEPARATOR" })) as Hex;
    return { ok: onchain.toLowerCase() === local.toLowerCase(), local, onchain };
  } catch {
    return { ok: false, local, onchain: null };
  }
}

export interface RelayRejection {
  error: string;
  status: number;
}
export interface RelayResult {
  tx: string;
  explorerUrl: string;
  from: string;
  to: string;
  usdc: number;
  /** what the relay cost US, in USDC — the gas the payer did not have to hold */
  gasPaidUsdc: number;
  gasUsed: string;
  relayer: string;
}

/** Split a 65-byte signature into (r, s, v) as the token expects. Exported because the v normalization below
 *  is a real interoperability hazard worth testing directly: wallets emit either the legacy {27,28} recovery id
 *  or the raw {0,1}, and passing the raw form straight through makes every relay revert. */
export function splitSignature(sig: Hex): { r: Hex; s: Hex; v: number } | null {
  const raw = sig.slice(2);
  if (raw.length !== 130) return null;
  const r = `0x${raw.slice(0, 64)}` as Hex;
  const s = `0x${raw.slice(64, 128)}` as Hex;
  let v = parseInt(raw.slice(128, 130), 16);
  // Wallets emit either the legacy {27,28} or the raw {0,1} recovery id; the token wants the legacy form.
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) return null;
  return { r, s, v };
}

/**
 * Validate and broadcast one signed authorization. Every failure mode is checked BEFORE the send, so a rejected
 * relay costs the relayer nothing:
 *
 *   · shape        — addresses, positive value, a 65-byte signature with a recoverable v
 *   · time window  — validAfter/validBefore against the chain's own clock, not the server's
 *   · replay       — `authorizationState(from, nonce)` must be false
 *   · Arc quirk    — a full-drain from a brand-new account (no balance history, no nonce, no code) reverts today
 *   · compliance   — both `from` and `to` are screened; a blocklisted party reverts at runtime and burns our gas
 *   · dry run      — an `eth_call` of the exact relay transaction, so any remaining revert is caught for free
 */
export async function relayTransferWithAuthorization(auth: Authorization): Promise<RelayResult | RelayRejection> {
  const pk = relayerKey();
  if (!pk || isStub()) return { error: "gasless relay is unavailable on this deployment (keyless / stub mode)", status: 503 };

  let from: `0x${string}`;
  let to: `0x${string}`;
  try {
    from = getAddress(auth.from);
    to = getAddress(auth.to);
  } catch {
    return { error: "from/to must be valid 0x addresses", status: 400 };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) return { error: "nonce must be a 0x-prefixed 32-byte value", status: 400 };
  let value: bigint;
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    value = BigInt(auth.value);
    validAfter = BigInt(auth.validAfter);
    validBefore = BigInt(auth.validBefore);
  } catch {
    return { error: "value/validAfter/validBefore must be integer strings (atomic units and unix seconds)", status: 400 };
  }
  if (value <= BigInt(0)) return { error: "value must be positive", status: 400 };
  const sig = splitSignature(auth.signature);
  if (!sig) return { error: "signature must be a 65-byte 0x hex string with a recoverable v", status: 400 };

  const client = pub();
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);

  try {
    const block = await client.getBlock();
    const now = block.timestamp;
    if (validAfter > now) return { error: `this authorization is not valid yet (validAfter ${validAfter} > chain time ${now})`, status: 400 };
    if (validBefore <= now) return { error: `this authorization has expired (validBefore ${validBefore} <= chain time ${now})`, status: 400 };

    const used = (await client.readContract({ address: ARC.usdc as `0x${string}`, abi: EIP3009_ABI, functionName: "authorizationState", args: [from, auth.nonce] })) as boolean;
    if (used) return { error: "this authorization nonce has already been used — sign a fresh one", status: 409 };

    // Arc's documented quirk: a transferWithAuthorization that fully drains a brand-new account (zero nonce and
    // no code) currently reverts. Detect it and say so, rather than burning gas on a guaranteed revert.
    const [balance, txCount, code] = await Promise.all([
      client.readContract({ address: ARC.usdc as `0x${string}`, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [from] }) as Promise<bigint>,
      client.getTransactionCount({ address: from }),
      client.getCode({ address: from }),
    ]);
    if (balance < value) return { error: `the signer holds ${round6(Number(balance) / 1e6)} USDC, less than the authorized ${round6(Number(value) / 1e6)}`, status: 400 };
    if (balance === value && txCount === 0 && (!code || code === "0x")) {
      return {
        error:
          "Arc currently reverts a transferWithAuthorization that fully drains a brand-new account (zero nonce, no code). Leave a small remainder, or send one transaction from this wallet first, then re-sign.",
        status: 422,
      };
    }

    // A blocklisted from/to reverts at runtime and consumes the relayer's gas with no transfer. Screen both.
    for (const [label, addr] of [["signer", from], ["recipient", to]] as const) {
      const gate = await assertPayeeCompliant(addr);
      if (!gate.allowed) return { error: `relay refused — the ${label} failed compliance screening (${gate.screen.reason})`, status: 403 };
    }

    const data = encodeFunctionData({
      abi: EIP3009_ABI,
      functionName: "transferWithAuthorization",
      args: [from, to, value, validAfter, validBefore, auth.nonce, sig.v, sig.r, sig.s],
    });

    // Final dry run as the relayer. A bad signature surfaces here, for free, instead of as a burned relay.
    try {
      await client.call({ account: account.address, to: ARC.usdc as `0x${string}`, data });
    } catch (e) {
      return { error: `the authorization would revert on-chain — ${(e as Error).message.slice(0, 140)}`, status: 400 };
    }

    const fees = await client.estimateFeesPerGas().catch(() => null);
    const maxFeePerGas = fees?.maxFeePerGas && fees.maxFeePerGas > ARC_MIN_MAX_FEE_PER_GAS ? fees.maxFeePerGas : ARC_MIN_MAX_FEE_PER_GAS;
    const wallet = createWalletClient({ account, transport: http(process.env.ARC_RPC_URL || ARC.rpcUrl) });
    const hash = await wallet.sendTransaction({
      to: ARC.usdc as `0x${string}`,
      data,
      chain: null,
      maxFeePerGas,
      maxPriorityFeePerGas: BigInt(0),
    });
    const rc = await client.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") return { error: "the relayed transfer reverted on-chain", status: 502 };

    // Arc prices gas in USDC: wei / 1e12 gives the 6-decimal token units the relay actually cost us.
    const gasCostUsdc = round6(Number((rc.gasUsed * rc.effectiveGasPrice) / BigInt(1e12)) / 1e6);
    return {
      tx: hash,
      explorerUrl: explorerTx(hash),
      from,
      to,
      usdc: round6(Number(value) / 1e6),
      gasPaidUsdc: gasCostUsdc,
      gasUsed: rc.gasUsed.toString(),
      relayer: account.address,
    };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 180), status: 502 };
  }
}
