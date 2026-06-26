/**
 * Merit x402 seller wrapper — adapted from arc-nanopayments lib/x402.ts, but
 * with a per-source `payTo` (each creator receives their own payments) and an
 * optional Supabase mirror. Used by /api/source/[id].
 */
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { NextRequest, NextResponse } from "next/server";
import { ARC } from "./arc";
import { recordPayment } from "./db";

const facilitator = new BatchFacilitatorClient();

interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; description: string; mimeType: string };
  accepted?: Record<string, unknown>;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

function buildRequirements(price: number, payTo: string) {
  const amount = Math.round(price * 1_000_000); // dollars → USDC atomic (6 dec)
  return {
    scheme: "exact" as const,
    network: ARC.network,
    asset: ARC.usdc,
    amount: amount.toString(),
    payTo: payTo as `0x${string}`,
    // Gateway requires the EIP-3009 authorization to be valid >= 7 days; use 8.
    maxTimeoutSeconds: 691200,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC.gatewayWallet,
    },
  };
}

/** Wrap a handler with Gateway payment verification, settling to `payTo`. */
export function withGatewaySeller(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: number,
  endpoint: string,
  payTo: string,
  description?: string,
) {
  const requirements = buildRequirements(price, payTo);

  return async (req: NextRequest) => {
    const sig = req.headers.get("payment-signature");

    if (!sig) {
      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: endpoint,
          description: description || `Merit source access ($${price} USDC)`,
          mimeType: "application/json",
        },
        accepts: [requirements],
      };
      return new NextResponse(JSON.stringify({}), {
        status: 402,
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(
            JSON.stringify(paymentRequired),
          ).toString("base64"),
        },
      });
    }

    // --- Pre-settlement: verify + settle. Failures here mean NO money moved → 402/500. ---
    let settleTx: string | undefined;
    let settleRaw: unknown;
    let payer = "unknown";
    try {
      const payload: PaymentPayload = JSON.parse(
        Buffer.from(sig, "base64").toString("utf-8"),
      );
      const verify = await facilitator.verify(payload, requirements);
      if (!verify.isValid) {
        console.error(`[seller] verify invalid for ${endpoint}:`, JSON.stringify(verify), "| requirements:", JSON.stringify(requirements));
        return NextResponse.json(
          { error: "verify failed", reason: verify.invalidReason },
          { status: 402 },
        );
      }
      const settle = await facilitator.settle(payload, requirements);
      if (!settle.success) {
        return NextResponse.json(
          { error: "settle failed", reason: settle.errorReason },
          { status: 402 },
        );
      }
      settleTx = settle.transaction;
      settleRaw = settle;
      payer = settle.payer ?? verify.payer ?? "unknown";
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[seller] pre-settlement error:", message);
      // Don't echo internal settlement details (Gateway payloads, addresses) to the caller.
      return NextResponse.json({ error: "payment processing error" }, { status: 500 });
    }

    // --- Post-settlement: money has moved on-chain. Bookkeeping below MUST NOT turn a
    // real payment into a buyer-visible failure, or the buyer would refund it. ---
    const amountUsdc = (Number(requirements.amount) / 1e6).toString();
    try {
      await recordPayment({
        endpoint,
        payer,
        amount_usdc: amountUsdc,
        network: requirements.network,
        gateway_tx: settleTx ?? null,
        raw: { payTo, settle: settleRaw },
      });
    } catch (e) {
      console.error("[seller] receipt mirror failed (payment still settled):", (e as Error).message);
    }

    let response: NextResponse;
    try {
      response = await handler(req);
    } catch (e) {
      // Money already moved — do NOT report a payment failure (the buyer would wrongly treat the
      // settled USDC as refunded). But the deliverable itself failed, so surface that instead of
      // claiming clean delivery: 200 + settled:true + contentError, never a bare {ok:true}.
      console.error("[seller] content handler failed AFTER settle:", (e as Error).message);
      response = NextResponse.json({ ok: true, settled: true, contentError: true });
    }
    try {
      response.headers.set(
        "PAYMENT-RESPONSE",
        Buffer.from(
          JSON.stringify({ success: true, transaction: settleTx, network: requirements.network, payer }),
        ).toString("base64"),
      );
    } catch {
      /* header set shouldn't fail */
    }
    return response;
  };
}
