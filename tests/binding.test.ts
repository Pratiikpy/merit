import { describe, it, expect } from "vitest";
import { recoverMessageAddress } from "viem";
import { verifyCitation, isVerifyError, bindingHash } from "../lib/verify/engine";
import { canonicalize } from "../lib/receipt";

// The payment binding (anti confused-deputy): the signed verdict names exactly which payment it authorizes.
const CLAIM = "Revenue was $9 billion for the quarter.";
const SOURCE = "The filing shows revenue was $2 billion for the quarter."; // numeric gate → REFUSED, keyless-safe

describe("payment binding", () => {
  it("folds a server-computed bindingHash into the verdict", async () => {
    const out = await verifyCitation(CLAIM, SOURCE, { sign: false, binding: { amount: 0.005, payee: "0xPayeeA" } });
    expect(isVerifyError(out)).toBe(false);
    if (isVerifyError(out)) return;
    const v = out.verdict;
    expect(v.binding).toBeDefined();
    expect(v.binding!.amount).toBe(0.005);
    expect(v.binding!.payee).toBe("0xPayeeA");
    expect(v.binding!.bindingHash).toBe(bindingHash(0.005, "0xPayeeA", CLAIM, v.sourceHash));
  });

  it("a different amount or payee yields a different bindingHash — a receipt cannot be replayed", async () => {
    const a = await verifyCitation(CLAIM, SOURCE, { sign: false, binding: { amount: 0.005, payee: "0xPayeeA" } });
    const b = await verifyCitation(CLAIM, SOURCE, { sign: false, binding: { amount: 5, payee: "0xPayeeA" } });
    const c = await verifyCitation(CLAIM, SOURCE, { sign: false, binding: { amount: 0.005, payee: "0xPayeeB" } });
    if (isVerifyError(a) || isVerifyError(b) || isVerifyError(c)) throw new Error("expected verdicts");
    expect(a.verdict.binding!.bindingHash).not.toBe(b.verdict.binding!.bindingHash);
    expect(a.verdict.binding!.bindingHash).not.toBe(c.verdict.binding!.bindingHash);
  });

  it("omits the binding when none was requested", async () => {
    const out = await verifyCitation(CLAIM, SOURCE, { sign: false });
    if (isVerifyError(out)) throw new Error("expected verdict");
    expect(out.verdict.binding).toBeUndefined();
  });

  it("the SIGNATURE covers the binding — recover the signer over the canonical body including binding", async () => {
    process.env.MERIT_SIGNING_KEY ||= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // well-known hardhat key, test-only
    const out = await verifyCitation(CLAIM, SOURCE, { binding: { amount: 0.01, payee: "0xPayeeA" } });
    if (isVerifyError(out)) throw new Error("expected verdict");
    const v = out.verdict as unknown as Record<string, unknown>;
    expect(v.signature).toBeDefined();
    const { signer, signature, verificationId: _vid, ...signed } = v;
    const recovered = await recoverMessageAddress({ message: canonicalize(signed), signature: signature as `0x${string}` });
    expect(recovered).toBe(signer);
    expect((signed as { binding?: unknown }).binding).toBeDefined(); // the recovered message INCLUDED the binding
  });
});
