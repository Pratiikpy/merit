import { NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/verify/signer — signer discovery for SDKs and hooks (JWKS-style, one address). A client that pins
// this instead of hardcoding an address survives a signing-key rotation without flipping fail-closed
// integrations to reject-everything. The address is derived from the configured signing key; nothing secret
// leaves the server. `bindingSpec` documents the versioned hash any consumer must be able to recompute.
export function GET() {
  const pk = process.env.MERIT_SIGNING_KEY || process.env.BUYER_PRIVATE_KEY;
  let signer: string | null = null;
  if (pk) {
    try {
      signer = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`).address;
    } catch {
      signer = null;
    }
  }
  return NextResponse.json({
    schema: "merit.signer/v1",
    signer, // null in a keyless deployment — verdicts are then unsigned and consumers must not fail-closed on signature
    scheme: "EIP-191 personal_sign over the canonical (sorted-keys) JSON of the verdict body, minus signer/signature/verificationId",
    recover: "viem recoverMessageAddress({ message: canonicalJson, signature }) === signer",
    bindingSpec: {
      version: 1,
      hash: "keccak256(utf8(canonicalJson({ amount, payee, claim, sourceHash })))",
      note: "keys sorted lexicographically; amount is the USDC number as given; a consumer MUST recompute and refuse a payment whose (amount, payee) do not match the verdict's binding.bindingHash",
    },
  });
}
