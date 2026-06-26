import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
import { verifyGhostSignature, parseGhostMember } from "../lib/ghost";

const secret = "whsec_test_secret";
const body = JSON.stringify({ member: { current: { id: "m1", email: "a@b.c", name: "Alice", status: "paid" } } });
const sign = (b: string, s: string) => "sha256=" + crypto.createHmac("sha256", s).update(b, "utf8").digest("hex");

describe("Ghost webhook receiver (W3)", () => {
  beforeAll(() => {
    delete process.env.GHOST_WEBHOOK_SECRET; // exercise the explicit-secret + no-secret paths deterministically
  });

  it("verifies a correct HMAC signature and rejects a wrong/short/missing one", () => {
    expect(verifyGhostSignature(body, sign(body, secret), secret)).toBe(true);
    expect(verifyGhostSignature(body, "sha256=deadbeef", secret)).toBe(false); // length mismatch
    expect(verifyGhostSignature(body, sign(body, "other-secret"), secret)).toBe(false);
    expect(verifyGhostSignature(body, null, secret)).toBe(false);
  });

  it("accepts when no secret is configured (open/dev mode)", () => {
    expect(verifyGhostSignature(body, null, undefined)).toBe(true);
  });

  it("parses the member from a member.* webhook payload", () => {
    expect(parseGhostMember(JSON.parse(body))).toEqual({ id: "m1", email: "a@b.c", name: "Alice", status: "paid" });
    expect(parseGhostMember({})).toBeNull();
    expect(parseGhostMember({ member: { current: {} } })).toBeNull();
  });
});
