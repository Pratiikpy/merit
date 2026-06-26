/**
 * Wallet provider abstraction (W2.2) — a wallet PER principal instead of one shared buyer EOA.
 *
 * Default ("eoa"): each principal/agent gets its OWN address, derived deterministically from a master seed +
 * the principal id (HD-style). No shared wallet, reproducible from MERIT_WALLET_SEED, fully local + testable.
 *
 * Drop-in ("circle-dcw"): managed Circle Developer-Controlled Wallets (SCA accounts on Arc) — KMS-custodied
 * keys, no plaintext, <60s no-MetaMask onboarding. Gated: requires CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET and
 * the @circle-fin/developer-controlled-wallets SDK. Selected via MERIT_WALLET=circle-dcw; when selected but
 * unconfigured it FAILS CLOSED with a clear error rather than silently falling back to a raw key.
 */
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type WalletMode = "eoa" | "circle-dcw";

export interface ManagedWallet {
  id: string;
  address: string;
  mode: WalletMode;
}

export function walletMode(): WalletMode {
  return process.env.MERIT_WALLET === "circle-dcw" ? "circle-dcw" : "eoa";
}

/** Deterministically derive a per-principal EOA from a master seed — each principal gets its OWN isolated,
 *  reproducible address (no shared buyer EOA). The default, fully-local provider. */
export function deriveWallet(principalId: string): ManagedWallet {
  const seed = process.env.MERIT_WALLET_SEED || "merit-dev-seed-do-not-use-in-production";
  const pk = keccak256(toHex(`${seed}:${principalId}`));
  const account = privateKeyToAccount(pk);
  return { id: principalId, address: account.address, mode: "eoa" };
}

/** Whether the managed Circle Developer-Controlled-Wallet path is configured (keys present). */
export function circleDcwConfigured(): boolean {
  return !!(process.env.CIRCLE_API_KEY && process.env.CIRCLE_ENTITY_SECRET);
}

interface DcwModule {
  initiateDeveloperControlledWalletsClient(opts: { apiKey?: string; entitySecret?: string }): DcwClient;
}
interface DcwClient {
  createWalletSet(req: { name: string }): Promise<{ data?: { walletSet?: { id?: string } } }>;
  createWallets(req: Record<string, unknown>): Promise<{ data?: { wallets?: Array<{ id?: string; address?: string }> } }>;
}

/** Provision a wallet for a principal. EOA mode derives deterministically + locally; circle-dcw mode creates
 *  a managed Circle SCA wallet on Arc (gated drop-in — fails closed when unconfigured). */
export async function provisionWallet(principalId: string, label?: string): Promise<ManagedWallet> {
  if (walletMode() !== "circle-dcw") return deriveWallet(principalId);
  if (!circleDcwConfigured()) {
    throw new Error("MERIT_WALLET=circle-dcw but CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET are not set");
  }
  // Optional SDK, only needed when MERIT_WALLET=circle-dcw. The bundler-ignore comments leave this as a pure
  // RUNTIME import so Turbopack/webpack never statically resolves (or globs) it — a bare variable specifier
  // with a static "@circle-fin/" prefix would make the bundler try to include every @circle-fin package.
  const spec = process.env.MERIT_DCW_PKG || "@circle-fin/developer-controlled-wallets";
  let mod: DcwModule;
  try {
    mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ spec)) as unknown as DcwModule;
  } catch {
    throw new Error("install @circle-fin/developer-controlled-wallets to use MERIT_WALLET=circle-dcw");
  }
  const client = mod.initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  });
  const walletSet = await client.createWalletSet({ name: `merit:${principalId}` });
  const res = await client.createWallets({
    blockchains: ["ARC-TESTNET"],
    count: 1,
    accountType: "SCA",
    walletSetId: walletSet.data?.walletSet?.id ?? "",
    metadata: label ? [{ name: label }] : undefined,
  });
  const w = res.data?.wallets?.[0];
  if (!w?.address) throw new Error("Circle wallet creation returned no address");
  return { id: w.id ?? principalId, address: w.address, mode: "circle-dcw" };
}
