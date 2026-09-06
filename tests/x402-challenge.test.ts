import { describe, it, expect } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { withGatewaySeller } from "../lib/seller";
import { ARC } from "../lib/arc";

/**
 * Regression: Merit's 402 carried its payment requirements ONLY in the base64 `PAYMENT-REQUIRED` header and
 * sent an empty `{}` body. Circle's batching client reads that header, so Merit's own buyer settled fine and
 * the gap stayed invisible — but the x402 protocol carries the requirements in the 402 BODY, which is what a
 * generic client reads (x402-fetch, the Bazaar, Circle's Agent Marketplace discovery). Every agent except
 * Merit's own therefore had nothing to pay with.
 *
 * Both forms must now be present, and they must agree.
 */

const PRICE = 0.005;
const PAY_TO = "0x415Fb8814084bDBC7B6964620Ba5Be5939aD2333";

function challenge() {
  const handler = async () => NextResponse.json({ ok: true });
  const sell = withGatewaySeller(handler, PRICE, "/api/verify/paid", PAY_TO, "Merit CVO — a signed verdict");
  // No `payment-signature` header → the 402 challenge path, which never touches the facilitator or a chain.
  return sell(new NextRequest("https://merit.test/api/verify/paid", { method: "POST" }));
}

describe("the x402 402 challenge", () => {
  it("puts the payment requirements in the BODY, where a standard x402 client reads them", async () => {
    const res = await challenge();
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body, "an empty body is what made Merit unpayable by every client but its own").not.toEqual({});
    expect(body.x402Version).toBe(2);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts).toHaveLength(1);
    expect(body.error).toBe("payment required");
  });

  it("still puts them in the PAYMENT-REQUIRED header, where Circle's batching client reads them", async () => {
    const res = await challenge();
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header, "removing the header would break Merit's own buyer").toBeTruthy();
    const decoded = JSON.parse(Buffer.from(header as string, "base64").toString("utf-8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toHaveLength(1);
  });

  it("says the same thing in both places", async () => {
    const res = await challenge();
    const body = await res.json();
    const decoded = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") as string, "base64").toString("utf-8"));
    expect(body.accepts).toEqual(decoded.accepts);
    expect(body.resource).toEqual(decoded.resource);
    // The body carries one field the header does not — the protocol's own error string.
    expect(decoded.error).toBeUndefined();
  });

  it("quotes the price, asset, network and payee a buyer needs to settle", async () => {
    const res = await challenge();
    const [accept] = (await res.json()).accepts;
    expect(accept.scheme).toBe("exact");
    expect(accept.network).toBe(ARC.network); // eip155:<chainId> — flips with the configured chain
    expect(accept.asset.toLowerCase()).toBe(ARC.usdc.toLowerCase());
    expect(accept.payTo).toBe(PAY_TO);
    expect(accept.amount).toBe(String(Math.round(PRICE * 1e6))); // atomic USDC, 6 decimals
    // Gateway rejects an authorization valid for under 7 days; Merit quotes 8.
    expect(accept.maxTimeoutSeconds).toBeGreaterThanOrEqual(7 * 24 * 3600);
  });

  it("declares the one thing that makes this rail different — settlement is gated on correctness", async () => {
    const res = await challenge();
    const [accept] = (await res.json()).accepts;
    expect(accept.extra.name).toBe("GatewayWalletBatched");
    expect(accept.extra.verifyingContract).toBe(ARC.gatewayWallet);
    expect(accept.extra.verificationGated).toBe(true);
  });

  it("serves JSON, so a client does not have to sniff the content type", async () => {
    const res = await challenge();
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
  });
});
