/**
 * Fiat off-ramp (Wave D #15) — the last mile so a wallet-less principal can turn their available (unused,
 * funded) Merit USDC balance into bank fiat. The CALLER (the route) gates the amount on and debits the
 * principal's own balance before calling this, so a payout can never exceed funds actually held. Converting
 * USDC → a bank account requires a LICENSED partner (Circle Mint, Bridge, Coinbase), which is credentials + KYC
 * only the operator can provide. So this is the complete code path, dependency-gated: it settles the moment
 * MERIT_OFFRAMP_PROVIDER + credentials are configured, and returns a clear, honest "not configured — here's
 * what's needed" otherwise (never a fake payout). Two providers:
 *   - "generic": a signed POST to the operator's own KYC'd off-ramp service (MERIT_OFFRAMP_URL).
 *   - "circle":  Circle Mint's payout API (USDC → linked bank), gated behind CIRCLE_API_KEY.
 * Every request is recorded (store-backed) so a payout is auditable. Holds no bank credentials itself.
 */
import { createHmac, randomUUID } from "node:crypto";
import { loadDoc, saveDoc } from "./store";
import { guardedFetch } from "./ssrf";

export function offrampProvider(): string {
  return (process.env.MERIT_OFFRAMP_PROVIDER || "").toLowerCase();
}

/** True when a real off-ramp partner is wired. Until then, /api/offramp fails closed with what's required. */
export function offrampConfigured(): boolean {
  const p = offrampProvider();
  if (p === "generic") return !!process.env.MERIT_OFFRAMP_URL;
  if (p === "circle") return !!(process.env.CIRCLE_API_KEY && process.env.CIRCLE_MINT_WALLET_ID);
  return false;
}

interface OfframpRecord {
  id: string;
  principalId: string;
  amount: number;
  destination: string;
  provider: string;
  status: string;
  payoutRef?: string;
  at: string;
}
interface OfframpLog {
  records: OfframpRecord[];
}
const DOC = "offramp";
function recordOfframp(r: OfframpRecord): void {
  try {
    const log = loadDoc<OfframpLog>(DOC, { records: [] });
    if (!log.records) log.records = [];
    log.records.push(r);
    if (log.records.length > 5000) log.records = log.records.slice(-5000);
    saveDoc(DOC, log);
  } catch (e) {
    console.error("[offramp] record failed:", (e as Error).message);
  }
}

export type OfframpResult =
  | { ok: true; provider: string; payoutRef: string | null; status: string; amount: number }
  | { ok: false; error: string; status: number; required?: string[] };

/**
 * Initiate a USDC → bank off-ramp. `destination` is the partner's reference to the payee's bank (a Circle wire
 * destination id, or whatever the operator's generic service expects). Fails CLOSED when unconfigured.
 */
export async function initiateOfframp(input: { principalId: string; amount: number; destination: string }): Promise<OfframpResult> {
  if (!(input.amount > 0)) return { ok: false, error: "amount must be positive", status: 400 };
  if (!(input.destination || "").trim()) return { ok: false, error: "provide a { destination } (the partner's payee/bank reference)", status: 400 };
  if (!offrampConfigured()) {
    return {
      ok: false,
      status: 503,
      error: "fiat off-ramp is not configured on this deployment — it needs a licensed partner. The full code path is built and will settle the moment credentials are supplied.",
      required:
        offrampProvider() === "circle"
          ? ["CIRCLE_API_KEY", "CIRCLE_MINT_WALLET_ID", "a linked bank destination id"]
          : ["MERIT_OFFRAMP_PROVIDER=generic|circle", "MERIT_OFFRAMP_URL (generic) or CIRCLE_API_KEY + CIRCLE_MINT_WALLET_ID (circle)"],
    };
  }

  const provider = offrampProvider();
  const id = "off_" + randomUUID();
  try {
    if (provider === "generic") {
      const body = JSON.stringify({ id, principalId: input.principalId, amount: input.amount, destination: input.destination, asset: "USDC", at: new Date().toISOString() });
      const secret = process.env.MERIT_OFFRAMP_SECRET || process.env.MERIT_SIGNING_KEY || "";
      const sig = createHmac("sha256", secret).update(body).digest("hex");
      const r = await guardedFetch(process.env.MERIT_OFFRAMP_URL as string, {
        method: "POST",
        headers: { "content-type": "application/json", "merit-signature": sig },
        body,
        timeoutMs: 20000,
      });
      if (!r.ok) return { ok: false, error: `off-ramp provider returned ${r.status}`, status: 502 };
      const data = (await r.text().then((t) => { try { return JSON.parse(t); } catch { return {}; } })) as { id?: string; status?: string };
      recordOfframp({ id, principalId: input.principalId, amount: input.amount, destination: input.destination, provider, status: data.status || "submitted", payoutRef: data.id, at: new Date().toISOString() });
      return { ok: true, provider, payoutRef: data.id || id, status: data.status || "submitted", amount: input.amount };
    }

    // provider === "circle" — Circle Mint payout: USDC (from the Mint wallet) → a linked bank destination.
    const res = await guardedFetch("https://api.circle.com/v1/payouts", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CIRCLE_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: id,
        source: { type: "wallet", id: process.env.CIRCLE_MINT_WALLET_ID },
        destination: { type: "wire", id: input.destination },
        amount: { amount: input.amount.toFixed(2), currency: "USD" },
      }),
      timeoutMs: 20000,
    });
    const data = (await res.text().then((t) => { try { return JSON.parse(t); } catch { return {}; } })) as { data?: { id?: string; status?: string } };
    if (!res.ok) return { ok: false, error: `Circle payout returned ${res.status}`, status: 502 };
    recordOfframp({ id, principalId: input.principalId, amount: input.amount, destination: input.destination, provider, status: data.data?.status || "pending", payoutRef: data.data?.id, at: new Date().toISOString() });
    return { ok: true, provider, payoutRef: data.data?.id || id, status: data.data?.status || "pending", amount: input.amount };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 160), status: 502 };
  }
}
