/**
 * Ghost integration (W3) — the "creators get paid + readers pay" loop on a 54k-star creator platform.
 *
 * A reader/agent pays test USDC on Arc → Merit verifies → a Ghost member.* webhook flips the member to paid
 * and credits the author's wallet. This module is the testable receiver boundary: HMAC signature
 * verification + member parsing. The on-chain settlement and the Ghost Admin API write-back (flip the member)
 * are the gated drop-ins (GHOST_ADMIN_KEY + the author payTo). Pure/deterministic so it's unit-tested.
 */
import crypto from "node:crypto";

/** Verify a Ghost webhook signature: HMAC-SHA256 over the raw body, header `sha256=<hex>, t=<ts>`. With no
 *  configured secret, returns true (open/dev mode). Length-checked + timing-safe. */
export function verifyGhostSignature(rawBody: string, signatureHeader: string | null, secret?: string): boolean {
  const sec = secret ?? process.env.GHOST_WEBHOOK_SECRET;
  if (!sec) return true; // no secret configured → accept (dev/open)
  if (!signatureHeader) return false;
  const m = signatureHeader.match(/sha256=([0-9a-fA-F]+)/);
  if (!m) return false;
  const expected = crypto.createHmac("sha256", sec).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(m[1], "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface GhostMember {
  id: string;
  email: string;
  name: string;
  status: string;
}

/** Extract the member from a Ghost member.* webhook body: { member: { current: {...}, previous: {...} } }. */
export function parseGhostMember(body: unknown): GhostMember | null {
  const cur = (body as { member?: { current?: Record<string, unknown> } })?.member?.current;
  if (!cur || typeof cur.id !== "string") return null;
  return {
    id: cur.id,
    email: typeof cur.email === "string" ? cur.email : "",
    name: typeof cur.name === "string" ? cur.name : "",
    status: typeof cur.status === "string" ? cur.status : "",
  };
}
