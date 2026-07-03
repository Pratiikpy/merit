/**
 * The AP2 fulfillment credential (Phase 4) — the POST-condition that closes the loop lib/mandate.ts opened.
 * A mandate is the AP2 PRE-condition ("pay up to $X for verified citations of scope S"); once Merit verifies the
 * work and settles, it mints a signed FULFILLMENT credential — a portable, offline-recoverable artifact that
 * attests "the obligation was satisfied: this settlement released against a verification that passed, id Z". A
 * downstream AP2/x402 rail can gate its NEXT step on this credential without trusting Merit: it recovers the
 * signer from the canonical body + signature (the same self-proving scheme as a verdict/receipt) and confirms the
 * verificationId ties back to the exact verdict that gated the payment. Merit only ever mints one on SUPPORTED —
 * a refused obligation yields no credential.
 */
import { signReceipt, verifyReceipt } from "./receipt";
import { round6 } from "./arc";

export interface FulfillmentCredential {
  schema: "merit.fulfillment/v1";
  type: "citation-payment-fulfillment";
  fulfilled: true;
  issuer: "merit";
  verificationId: string; // the verdict join key this credential attests to
  claim: string;
  sourceName?: string;
  amount: number; // USDC settled against the verified work
  mandate?: { authorizer: string; nonce: string }; // the AP2 intent mandate this fulfills, when settled under one
  settledAt: string; // ISO timestamp of settlement
  receiptId?: string; // the /v/<id> receipt this credential accompanies
  signer?: string; // recovered offline from the signature (absent on a keyless deployment)
  signature?: string; // over the canonical credential body
}

export interface FulfillmentInput {
  verificationId: string;
  claim: string;
  amount: number;
  settledAt: string;
  sourceName?: string;
  mandate?: { authorizer: string; nonce: string };
  receiptId?: string;
}

/** Mint a signed fulfillment credential for a verified settlement. Signature is best-effort: a keyless
 *  deployment emits the credential unsigned (like a verdict), never fails. */
export async function mintFulfillment(input: FulfillmentInput): Promise<FulfillmentCredential> {
  const body: Omit<FulfillmentCredential, "signer" | "signature"> = {
    schema: "merit.fulfillment/v1",
    type: "citation-payment-fulfillment",
    fulfilled: true,
    issuer: "merit",
    verificationId: input.verificationId,
    claim: input.claim,
    ...(input.sourceName ? { sourceName: input.sourceName } : {}),
    amount: round6(input.amount),
    ...(input.mandate ? { mandate: input.mandate } : {}),
    settledAt: input.settledAt,
    ...(input.receiptId ? { receiptId: input.receiptId } : {}),
  };
  const sig = await signReceipt(body);
  return sig ? { ...body, signer: sig.signer, signature: sig.signature } : { ...body };
}

/** Offline check: recover the signer from a received credential and confirm it matches its stated signer. Uses
 *  the same strip-signer/signature-then-recanonicalize scheme as a signed verdict, so a third party verifies a
 *  credential with no Merit server. */
export async function verifyFulfillment(cred: Record<string, unknown>): Promise<{ ok: boolean; recovered: string | null }> {
  return verifyReceipt(cred);
}
