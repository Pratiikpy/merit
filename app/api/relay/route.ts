import { NextResponse } from "next/server";
import { authGate, keyFromRequest, refreshAuthFromMirror, MISSING_KEY_ERROR } from "@/lib/auth";
import { isSessionKey } from "@/lib/session";
import { creditDeposit, balanceStatus, depositAddressFor, refreshBalanceFromMirror } from "@/lib/balance";
import { ARC, isStub } from "@/lib/arc";
import { walletSeedConfigured } from "@/lib/wallet";
import {
  ARC_MIN_MAX_FEE_PER_GAS,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_EIP712_DOMAIN,
  domainMatchesChain,
  relayTransferWithAuthorization,
  relayerAddress,
  relayerConfigured,
  type Authorization,
} from "@/lib/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // a relayed transfer waits on an on-chain receipt

/**
 * Gasless funding (EIP-3009).
 *
 * On Arc, gas is USDC — so a wallet holding exactly the USDC it wants to spend cannot spend it. This endpoint
 * removes that cold start: the payer signs a `TransferWithAuthorization` message, Merit broadcasts it and pays
 * the gas, and the USDC lands in the payer's own prepaid deposit address. No transaction from the payer, no gas
 * balance required, no seed phrase touched by us — only a signature.
 *
 *   GET  /api/relay   the exact EIP-712 domain and types to sign, the relayer's address, and where to send it
 *   POST /api/relay   { from, to, value, validAfter, validBefore, nonce, signature } → relayed, then credited
 *
 * The GET also reports whether the domain we publish matches the token's own `DOMAIN_SEPARATOR` on Arc, so a
 * client can confirm it is signing something the contract will actually accept before it asks a user to sign.
 */

async function principalOr401(req: Request) {
  if (isSessionKey(keyFromRequest(req)))
    return { error: "a session key can only verify; use the parent API key to fund a balance", status: 403 } as const;
  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  if (!gate.ok) return { error: gate.error, status: gate.status } as const;
  if (!gate.principal) return { error: `gasless funding requires an API key — ${MISSING_KEY_ERROR}`, status: 401 } as const;
  return { principal: gate.principal } as const;
}

export async function GET(req: Request) {
  const g = await principalOr401(req);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const depositReady = isStub() || walletSeedConfigured();
  const domain = await domainMatchesChain();
  return NextResponse.json({
    schema: "merit.relay/v1",
    enabled: relayerConfigured(),
    relayer: relayerAddress(),
    ...(relayerConfigured() ? {} : { note: "no relayer key is configured on this deployment — sign-and-relay is unavailable here" }),
    // Sign THIS domain and THESE types. `domainMatchesChain` is the proof that the token agrees.
    eip712: {
      domain: USDC_EIP712_DOMAIN,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      domainSeparator: { computed: domain.local, onchain: domain.onchain, matches: domain.ok },
    },
    // Where the money should go for it to become prepaid balance. Anything else is relayed but not credited.
    depositTo: depositReady ? depositAddressFor(g.principal.id) : null,
    depositsEnabled: depositReady,
    token: { address: ARC.usdc, decimals: 6, chainId: ARC.chainId },
    gas: {
      paidBy: "Merit's relayer, in USDC",
      minMaxFeePerGasWei: ARC_MIN_MAX_FEE_PER_GAS.toString(),
      note: "Arc rejects a maxFeePerGas under 20 Gwei; the relayer sets that floor for you.",
    },
    howTo: [
      "1. Generate a random bytes32 nonce (this is the replay key, NOT your account nonce).",
      "2. Sign the TransferWithAuthorization struct above with your wallet (signTypedData) — from = your address, to = depositTo.",
      "3. POST the signed fields here. Merit broadcasts it, pays the gas, and credits the deposit to your balance.",
    ],
  });
}

export async function POST(req: Request) {
  const g = await principalOr401(req);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });

  let body: Partial<Authorization>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const missing = (["from", "to", "value", "validAfter", "validBefore", "nonce", "signature"] as const).filter((k) => !body[k]);
  if (missing.length) {
    return NextResponse.json(
      { error: `missing ${missing.join(", ")} — GET /api/relay returns the exact domain and types to sign`, missing },
      { status: 400 },
    );
  }

  const res = await relayTransferWithAuthorization(body as Authorization);
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });

  // If the payer sent it to their OWN deposit address, close the loop and credit the balance from the relayed
  // transaction — proven the same way any other deposit is, by reading the transfer out of the chain logs. A
  // relay to any other address is a legitimate gasless transfer; it is simply not a Merit deposit, and the
  // response says which of the two happened rather than implying a credit that did not occur.
  const depositReady = isStub() || walletSeedConfigured();
  const mine = depositReady ? depositAddressFor(g.principal.id) : null;
  let credited: Record<string, unknown> | null = null;
  let creditNote: string | null = null;
  if (mine && res.to.toLowerCase() === mine.toLowerCase()) {
    await refreshBalanceFromMirror().catch(() => {});
    const c = await creditDeposit(g.principal.id, res.tx);
    if ("error" in c) creditNote = `the transfer settled on-chain but crediting it failed — ${c.error} (retry with POST /api/balance {action:"deposit", txHash})`;
    else credited = { ...c };
  } else {
    creditNote = `relayed to ${res.to}, which is not your deposit address — no prepaid balance was credited`;
  }

  return NextResponse.json({
    ok: true,
    ...res,
    gasless: true,
    credited,
    creditNote,
    balance: balanceStatus(g.principal.id),
    memoUrl: null, // an EIP-3009 relay is a direct token call; memos wrap OUR payouts, not a payer's authorization
  });
}
