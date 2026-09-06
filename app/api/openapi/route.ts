import { NextResponse } from "next/server";
import { ARC, chainLabel } from "@/lib/arc";
import { verifyDepthPrice } from "@/lib/pricing";
import { publicOrigin } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/openapi — the machine-readable contract for Merit's public and paid surface.
 *
 * Circle's Agent Marketplace requires a published OpenAPI spec before a service can be listed, for the obvious
 * reason: an agent that discovers a priced endpoint still has to know what to send it. This is generated from
 * the same live configuration the endpoints themselves use — the price ladder, the active chain, the payout
 * address — so the spec cannot drift from the service the way a hand-maintained file does.
 *
 * The paid operations carry an `x-x402` block naming the price, asset, network and payee, mirroring what the
 * 402 challenge quotes, so a buyer can budget before it ever sends a request.
 */
export async function GET(req: Request) {
  const origin = publicOrigin(req);
  const cvoPrice = verifyDepthPrice("full");
  const payTo = process.env.MERIT_CVO_WALLET || process.env.BUYER_ADDRESS || "";

  const x402 = (price: number) => ({
    protocol: "x402",
    scheme: "exact",
    asset: "USDC",
    assetAddress: ARC.usdc,
    network: ARC.network,
    chain: chainLabel(),
    priceUsdc: price,
    payTo,
    settlement: "Circle Gateway batched nanopayments (@circle-fin/x402-batching)",
    note: "An unpaid request returns 402 with the payment requirements in BOTH the response body and the base64 PAYMENT-REQUIRED header.",
  });

  const verdict = {
    type: "object",
    description: "A signed verdict. Recover the signer offline from the canonical body plus `signature` — no Merit server required.",
    properties: {
      verdict: { type: "string", enum: ["SUPPORTED", "REFUSED"] },
      grounded: { type: "boolean", description: "true only when the source actually supports the claim; the settlement switch." },
      score: { type: "number", nullable: true, description: "support evidence, 0..1" },
      reason: { type: "string" },
      methods: { type: "array", items: { type: "string" }, description: "which gates ran: numeric, nli, adversarial-judge" },
      verificationId: { type: "string", description: "keccak256 of the canonical signed verdict — the join key across the receipt, the /proof ledger, the on-chain memo and the settlement hook." },
      signer: { type: "string" },
      signature: { type: "string" },
      schema: { type: "string", example: "merit.cvo/v2" },
    },
  };

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Merit — proof-of-citation verification",
      version: "1.0.0",
      description:
        "Merit answers the question the agent-payment stack leaves open. x402 settles how an agent pays; x401 settles who authorized it; neither checks whether the work was correct. Merit verifies that a cited source actually supports the claim made from it, and gates the payment on the verdict — so a wrong citation is refused and costs nothing. Verdicts are signed and offline-verifiable; payouts on Arc carry an on-chain memo naming the verifications behind them.",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
      contact: { name: "Merit", url: origin },
    },
    servers: [{ url: origin, description: chainLabel() }],
    tags: [
      { name: "verification", description: "The oracle: is this citation actually supported?" },
      { name: "settlement", description: "Verified payment and its on-chain proof" },
      { name: "proof", description: "Public, checkable records" },
    ],
    paths: {
      "/api/verify": {
        post: {
          tags: ["verification"],
          operationId: "verifyCitation",
          summary: "Verify a claim against its source (free tier)",
          description: "Returns a signed SUPPORTED/REFUSED verdict. Free and unauthenticated for adoption and demos; the metered equivalent is /api/verify/paid.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["claim", "source"],
                  properties: {
                    claim: { type: "string", description: "The assertion made from the source." },
                    source: { type: "string", description: "The source text the claim cites." },
                    depth: { type: "string", enum: ["numeric", "nli", "full"], default: "full", description: "How hard the check tries. Price scales with this, never with retrieval." },
                  },
                },
                example: {
                  claim: "Stablecoin settlement volume reached $2.1 trillion in 2026.",
                  source: "Total stablecoin settlement volume was $1.4 trillion across 2026.",
                  depth: "full",
                },
              },
            },
          },
          responses: {
            200: { description: "A signed verdict.", content: { "application/json": { schema: verdict } } },
            400: { description: "Missing or malformed claim/source." },
            503: { description: "No verification model is reachable. The deterministic numeric gate still refuses fabricated figures; the response says which capability is unavailable and why." },
          },
        },
      },
      "/api/verify/paid": {
        post: {
          tags: ["verification", "settlement"],
          operationId: "verifyCitationPaid",
          summary: "Verify a claim against its source (metered, x402)",
          description: `The same engine and the same signed verdict as /api/verify, behind an x402 toll of $${cvoPrice} USDC per call. An unpaid request returns 402 with the payment requirements; a paid request returns the verdict plus a permalinked receipt.`,
          "x-x402": x402(cvoPrice),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["claim", "source"],
                  properties: {
                    claim: { type: "string" },
                    source: { type: "string" },
                  },
                },
                example: { claim: "Water boils at 100C at sea level.", source: "At sea level, water boils at 100 degrees Celsius." },
              },
            },
          },
          responses: {
            200: {
              description: "Payment settled; the signed verdict and its receipt.",
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      verdict,
                      {
                        type: "object",
                        properties: {
                          paid: { type: "boolean" },
                          cached: { type: "boolean", description: "A previously computed identical verdict was reused." },
                          receiptId: { type: "string" },
                          receiptUrl: { type: "string", format: "uri" },
                          settlement: { type: "string", description: "Whether a verification-gated payment may settle this citation." },
                        },
                      },
                    ],
                  },
                },
              },
            },
            402: {
              description: "Payment required. The requirements are in the body AND the base64 PAYMENT-REQUIRED header.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      x402Version: { type: "integer", example: 2 },
                      error: { type: "string", example: "payment required" },
                      resource: { type: "object" },
                      accepts: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/pricing": {
        get: {
          tags: ["verification"],
          operationId: "getPricing",
          summary: "The price ladder, by verification depth",
          description: "Machine-readable tiers so an agent can choose depth against cost before it calls.",
          responses: { 200: { description: "The tier list and the endpoints that accept each." } },
        },
      },
      "/api/memo": {
        get: {
          tags: ["proof"],
          operationId: "readMemo",
          summary: "Read the Arc memo inside a payment",
          description:
            "Merit's payouts go through Arc's predeployed Memo contract, so the transaction itself names the verified work it settled. Pass ?tx= to read one payment's memos and re-derive every claim they make, or ?id= to find payments by memoId straight from chain logs. Arc's RPC caps a log query at 10,000 blocks, so an id search reports the window it covered.",
          parameters: [
            { name: "tx", in: "query", schema: { type: "string" }, description: "0x-prefixed 32-byte transaction hash." },
            { name: "id", in: "query", schema: { type: "string" }, description: "0x-prefixed bytes32 memoId." },
            { name: "blocks", in: "query", schema: { type: "integer", default: 10000 }, description: "Search window for an id lookup." },
          ],
          responses: {
            200: { description: "The decoded memos, their audit checks, and the USDC transfers from both of Arc's emitters." },
            400: { description: "Neither tx nor id supplied, or a malformed value." },
            404: { description: "No such transaction on Arc." },
          },
        },
      },
      "/api/reconcile": {
        get: {
          tags: ["proof"],
          operationId: "reconcileLedger",
          summary: "Audit the published ledger against Arc",
          description:
            "Both directions: every published settlement re-read from chain logs and cross-checked against Arc's two USDC emitters (the 18-decimal EIP-7708 system log and the 6-decimal ERC-20 log), plus a bounded scan of outbound USDC flagging anything the ledger does not explain.",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 25, maximum: 100 } },
            { name: "blocks", in: "query", schema: { type: "integer", default: 20000 }, description: "Outflow scan window." },
          ],
          responses: { 200: { description: "ledgerToChain, chainToLedger, and what is not chain-checkable and why." } },
        },
      },
      "/api/proof": {
        get: {
          tags: ["proof"],
          operationId: "getProofLedger",
          summary: "The public verification and settlement ledger",
          description: "Verified vs REFUSED across the tamper-evident audit chain, cumulative USDC settled, and recent receipts.",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 40, maximum: 100 } }],
          responses: { 200: { description: "The ledger." } },
        },
      },
      "/api/relay": {
        get: {
          tags: ["settlement"],
          operationId: "getRelayTerms",
          summary: "The EIP-712 domain and types to sign for gasless funding",
          description:
            "Gas on Arc is USDC, so a wallet holding exactly what it means to spend cannot spend it. Sign a TransferWithAuthorization (EIP-3009) and Merit broadcasts it and pays the gas. This returns the domain, the types, and proof that the domain matches the token's own DOMAIN_SEPARATOR on chain.",
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: "Domain, types, relayer address and deposit target." }, 401: { description: "API key required." } },
        },
        post: {
          tags: ["settlement"],
          operationId: "relayAuthorization",
          summary: "Relay a signed EIP-3009 authorization (payer needs no gas)",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["from", "to", "value", "validAfter", "validBefore", "nonce", "signature"],
                  properties: {
                    from: { type: "string" },
                    to: { type: "string" },
                    value: { type: "string", description: "Atomic USDC (6 decimals), as a decimal string." },
                    validAfter: { type: "string" },
                    validBefore: { type: "string" },
                    nonce: { type: "string", description: "A random bytes32 — the replay key, not an account nonce." },
                    signature: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Relayed on-chain; includes the gas Merit paid on the payer's behalf." },
            400: { description: "The authorization would revert (bad signature, expired, insufficient balance)." },
            409: { description: "This authorization nonce has already been used." },
          },
        },
      },
      "/api/settle/batch": {
        post: {
          tags: ["settlement"],
          operationId: "settleVerifiedBatch",
          summary: "Net a basket of citations down to the verified subset, and settle only those",
          description: "Authorize N lines; Merit verifies each and settles only the ones whose source actually supports the claim. The rest are quarantined and never paid.",
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: "Per-line verdicts plus the settled/quarantined totals." }, 401: { description: "API key required." } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Authorization: Bearer <API key>. Call the canonical host directly — HTTP clients drop this header across a cross-host redirect." },
      },
    },
    "x-merit": {
      moat: "Settlement is gated on whether the work is correct, not on identity, reputation or attested execution.",
      chain: { network: ARC.name, label: chainLabel(), chainId: ARC.chainId, usdc: ARC.usdc, explorer: ARC.explorer },
      discovery: `${origin}/.well-known/x402`,
      proof: `${origin}/api/reconcile`,
    },
  };

  return NextResponse.json(spec, { headers: { "Cache-Control": "public, max-age=300" } });
}
