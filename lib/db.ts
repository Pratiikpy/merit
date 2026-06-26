/**
 * Optional Supabase mirror for receipts. The app is fully functional without
 * it (registry is file-backed); Supabase only adds durable receipts + realtime.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient | null {
  if (client) return client;
  // Prefer the server-only name; fall back to the NEXT_PUBLIC_ one for compatibility.
  // (Used server-side only — the NEXT_PUBLIC_ prefix is a misleading legacy name.)
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || url.startsWith("your-")) return null;
  client = createClient(url, key);
  return client;
}

export async function recordPayment(row: {
  endpoint: string;
  payer: string;
  amount_usdc: string;
  network: string;
  gateway_tx: string | null;
  raw?: unknown;
}) {
  const c = db();
  if (!c) return;
  try {
    await c.from("payment_events").insert(row);
  } catch (e) {
    console.error("[db] recordPayment failed:", (e as Error).message);
  }
}
