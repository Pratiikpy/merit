import { describe, it, expect } from "vitest";
import { MeritClient, MeritError, canonicalize as sdkCanon, computeBindingHash } from "../packages/merit-verify/src/index";
import { canonicalize as serverCanon, signReceiptWith } from "../lib/receipt";
import { bindingHash as serverBindingHash } from "../lib/verify/engine";

const HH_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // well-known hardhat key, test-only
const HH_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // the address of HH_KEY (hardhat account #1)

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; json: unknown }): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const { status, json } = handler(String(url), init);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function signedVerdict(binding?: { amount: number; payee: string }) {
  const claim = "Revenue was $2 billion.";
  const sourceHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
  const body: Record<string, unknown> = {
    schema: "merit.cvo/v2",
    claim,
    sourceHash,
    verdict: "SUPPORTED",
    grounded: true,
    score: 0.9,
    methods: ["numeric"],
    reason: "test",
    verifiedAt: "2026-08-04T00:00:00.000Z",
  };
  if (binding) body.binding = { ...binding, bindingHash: computeBindingHash(binding.amount, binding.payee, claim, sourceHash) };
  const sig = await signReceiptWith(HH_KEY, body);
  return { ...body, ...sig } as never;
}

describe("SDK ↔ server spec agreement", () => {
  it("canonicalize matches the server byte-for-byte", () => {
    const v = { b: 1, a: { z: [3, 1], y: undefined, x: "s" }, c: null };
    expect(sdkCanon(v)).toBe(serverCanon(v));
  });
  it("computeBindingHash matches the server's bindingHash", () => {
    const h = ("0x" + "cd".repeat(32)) as `0x${string}`;
    expect(computeBindingHash(0.005, "0xA", "claim text", h)).toBe(serverBindingHash(0.005, "0xA", "claim text", h));
  });
});

describe("constructor contract", () => {
  it("throws without a failureMode — the outage policy must be pre-committed", () => {
    expect(() => new MeritClient({} as never)).toThrow(MeritError);
  });
});

describe("verifyLocal — never trust a boolean", () => {
  it("accepts a genuinely signed verdict from the pinned signer", async () => {
    const c = new MeritClient({ failureMode: "fail-closed", trustedSigner: HH_ADDR });
    const check = await c.verifyLocal(await signedVerdict());
    expect(check.signed).toBe(true);
    expect(check.signerOk).toBe(true);
    expect(check.ok).toBe(true);
  });

  it("rejects a tampered verdict (flip REFUSED→SUPPORTED after signing)", async () => {
    const c = new MeritClient({ failureMode: "fail-closed", trustedSigner: HH_ADDR });
    const v = (await signedVerdict()) as Record<string, unknown>;
    v.reason = "tampered after signing";
    const check = await c.verifyLocal(v as never);
    expect(check.signerOk).toBe(false);
    expect(check.ok).toBe(false);
  });

  it("rejects a signer that is not the trusted one", async () => {
    const c = new MeritClient({ failureMode: "fail-closed", trustedSigner: "0x0000000000000000000000000000000000000001" });
    const check = await c.verifyLocal(await signedVerdict());
    expect(check.signerOk).toBe(false);
  });

  it("ANTI CONFUSED-DEPUTY: a verdict bound to one payment does not authorize another", async () => {
    const c = new MeritClient({ failureMode: "fail-closed", trustedSigner: HH_ADDR });
    const v = await signedVerdict({ amount: 0.005, payee: "0xPayeeA" });
    expect((await c.verifyLocal(v, { amount: 0.005, payee: "0xPayeeA" })).ok).toBe(true);
    expect((await c.verifyLocal(v, { amount: 50, payee: "0xPayeeA" })).bindingOk).toBe(false); // different amount
    expect((await c.verifyLocal(v, { amount: 0.005, payee: "0xPayeeB" })).bindingOk).toBe(false); // different payee
    expect((await c.verifyLocal(await signedVerdict(), { amount: 1, payee: "0xA" })).bindingOk).toBe(false); // no binding at all
  });
});

describe("failure modes — pre-committed, never a 3am surprise", () => {
  const down = mockFetch(() => ({ status: 503, json: { error: "busy" } }));

  it("fail-closed refuses when the verifier is unreachable", async () => {
    const c = new MeritClient({ failureMode: "fail-closed", fetchImpl: down });
    const v = await c.verify("claim", "source");
    expect(v.verdict).toBe("REFUSED");
    expect(v.schema).toBe("merit.sdk.synthetic/v1"); // clearly labeled as policy-synthesized
  });

  it("fail-open supports, loudly labeled", async () => {
    const c = new MeritClient({ failureMode: "fail-open", fetchImpl: down });
    const v = await c.verify("claim", "source");
    expect(v.verdict).toBe("SUPPORTED");
    expect(v.reason).toMatch(/fail-open/);
  });

  it("last-good-verdict reuses a recent good verdict, else fails closed", async () => {
    let fail = false;
    const good = await signedVerdict();
    const f = mockFetch(() => (fail ? { status: 503, json: { error: "busy" } } : { status: 200, json: good }));
    const c = new MeritClient({ failureMode: "last-good-verdict", fetchImpl: f });
    await c.verify("claim", "source"); // primes the cache
    fail = true;
    const v = await c.verify("claim", "source");
    expect(v.verdict).toBe("SUPPORTED");
    expect(v.reason).toMatch(/last-good-verdict/);
    const miss = await c.verify("different", "pair"); // no cached verdict for this pair
    expect(miss.verdict).toBe("REFUSED");
  });
});

describe("verifyThenPay — the paved path", () => {
  it("pays on a good bound verdict and passes it to pay()", async () => {
    const v = await signedVerdict({ amount: 0.01, payee: "0xPayeeA" });
    const c = new MeritClient({ failureMode: "fail-closed", trustedSigner: HH_ADDR, fetchImpl: mockFetch(() => ({ status: 200, json: v })) });
    let paidTo = "";
    const out = await c.verifyThenPay({ claim: "Revenue was $2 billion.", source: "s", amount: 0.01, payee: "0xPayeeA", pay: (vd) => (paidTo = vd.binding!.payee) });
    expect(out.paid).toBe(true);
    expect(paidTo).toBe("0xPayeeA");
  });

  it("REFUSES to pay when the server's binding does not match the requested payment", async () => {
    const v = await signedVerdict({ amount: 0.01, payee: "0xPayeeA" }); // server bound A…
    const c = new MeritClient({ failureMode: "fail-closed", trustedSigner: HH_ADDR, fetchImpl: mockFetch(() => ({ status: 200, json: v })) });
    await expect(
      c.verifyThenPay({ claim: "Revenue was $2 billion.", source: "s", amount: 5, payee: "0xPayeeB", pay: () => "MUST NOT RUN" }),
    ).rejects.toThrow(MeritError); // …the SDK refuses to pay B
  });

  it("does not pay on REFUSED", async () => {
    const refused = { ...((await signedVerdict()) as Record<string, unknown>) };
    refused.verdict = "REFUSED"; // note: signature now invalid too, but REFUSED short-circuits first
    const c = new MeritClient({ failureMode: "fail-closed", trustedSigner: HH_ADDR, fetchImpl: mockFetch(() => ({ status: 200, json: refused })) });
    const out = await c.verifyThenPay({ claim: "x", source: "s", amount: 1, payee: "0xA", pay: () => "MUST NOT RUN" });
    expect(out.paid).toBe(false);
    expect(out.result).toBeUndefined();
  });
});
