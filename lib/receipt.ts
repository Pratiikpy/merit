/**
 * Self-proving receipts. The run summary is signed by the BUYER (the paying wallet), so "signed receipt"
 * is not a claim to trust but a fact to check: anyone recovers the signer from the canonical body + the
 * signature — fully offline, no Merit server (scripts/verify-receipt.mjs) — and confirms it equals the
 * wallet that actually moved the USDC. Best-effort: a keyless STUB run emits the receipt unsigned rather
 * than failing the run.
 */
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";

// Deterministic JSON with recursively-sorted keys, so the signed bytes are reproducible by any verifier
// (the verifier re-canonicalizes the same body and must get identical bytes to recover the same signer).
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeys((v as Record<string, unknown>)[k]);
        return acc;
      }, {} as Record<string, unknown>);
  }
  return v;
}
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function normalizeKey(pk: string): `0x${string}` {
  return (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
}

/** Sign a receipt body with an explicit key — the testable core. */
export async function signReceiptWith(pk: string, body: unknown): Promise<{ signer: string; signature: string }> {
  const account = privateKeyToAccount(normalizeKey(pk));
  const signature = await account.signMessage({ message: canonicalize(body) });
  return { signer: account.address, signature };
}

/** Sign the receipt with the buyer (paying) wallet. Returns null if no key is available (keyless STUB). */
export async function signReceipt(body: unknown): Promise<{ signer: string; signature: string } | null> {
  const pk = process.env.BUYER_PRIVATE_KEY;
  if (!pk) return null;
  try {
    return await signReceiptWith(pk, body);
  } catch {
    return null;
  }
}

/** Recover + check the signer of a received receipt (strips signer/signature, re-canonicalizes the rest). */
export async function verifyReceipt(
  receipt: Record<string, unknown>,
): Promise<{ ok: boolean; recovered: string | null }> {
  const { signer, signature, ...body } = receipt;
  if (typeof signer !== "string" || typeof signature !== "string") return { ok: false, recovered: null };
  try {
    const recovered = await recoverMessageAddress({ message: canonicalize(body), signature: signature as `0x${string}` });
    return { ok: recovered.toLowerCase() === signer.toLowerCase(), recovered };
  } catch {
    return { ok: false, recovered: null };
  }
}
