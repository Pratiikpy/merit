import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * Arc is a network, not a constant.
 *
 * Merit was written against Arc Testnet with chain 5042002 hard-coded in nine modules. Circle has not published
 * Arc mainnet addresses yet — the Arc docs say so, and Circle's own Gateway SDK ships `arcTestnet` with no
 * mainnet counterpart — so "mainnet-ready" cannot mean "we guessed the addresses". It has to mean two things,
 * and these tests hold both:
 *
 *   1. the default is byte-identical to the testnet Merit has always run on, and
 *   2. one environment switch moves the whole app, with every unset value reported rather than substituted.
 */

const ORIGINAL_ENV = { ...process.env };

async function freshArc(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return await import("../lib/arc");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("the testnet default is unchanged", () => {
  it("is the exact chain, RPC and explorer every verified transaction in this repo used", async () => {
    const { ARC, arcNetworkName } = await freshArc({ ARC_NETWORK: undefined, ARC_RPC_URL: undefined, ARC_EXPLORER: undefined });
    expect(arcNetworkName()).toBe("testnet");
    expect(ARC.chainId).toBe(5042002);
    expect(ARC.network).toBe("eip155:5042002");
    expect(ARC.rpcUrl).toBe("https://rpc.testnet.arc.network");
    expect(ARC.explorer).toBe("https://testnet.arcscan.app");
    expect(ARC.isTestnet).toBe(true);
  });

  it("keeps every address the on-chain work was verified against", async () => {
    const { ARC } = await freshArc({ ARC_NETWORK: undefined });
    expect(ARC.usdc).toBe("0x3600000000000000000000000000000000000000");
    expect(ARC.gatewayWallet).toBe("0x0077777d7EBA4688BDeF3E311b846F25870A19B9");
    expect(ARC.identityRegistry).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
    expect(ARC.reputationRegistry).toBe("0x8004B663056A597Dffe9eCcC1965A193B7388713");
    expect(ARC.validationRegistry).toBe("0x8004Cb1BF31DAf7788923b405b754f57acEB4272");
    expect(ARC.memo).toBe("0x5294E9927c3306DcBaDb03fe70b92e01cCede505");
    expect(ARC.multicall3From).toBe("0x522fAf9A91c41c443c66765030741e4AaCe147D0");
    expect(ARC.systemTransferEmitter).toBe("0xfffffffffffffffffffffffffffffffffffffffe");
    expect(ARC.gatewayChainName).toBe("arcTestnet"); // Circle Gateway domain 26
  });

  it("uses viem's own arcTestnet chain, so nothing verified here changes", async () => {
    const { arcChain } = await freshArc({ ARC_NETWORK: undefined });
    const { arcTestnet } = await import("viem/chains");
    expect(arcChain()).toBe(arcTestnet);
  });

  it("does not treat an unrecognised ARC_NETWORK as mainnet — the safe direction", async () => {
    const { ARC } = await freshArc({ ARC_NETWORK: "MAINNET_TYPO" });
    expect(ARC.name).toBe("testnet");
    expect(ARC.chainId).toBe(5042002);
  });

  it("accepts ARC_NETWORK=mainnet case-insensitively and with stray whitespace", async () => {
    const { arcNetworkName } = await freshArc({ ARC_NETWORK: "  MainNet " });
    expect(arcNetworkName()).toBe("mainnet");
  });
});

describe("the mainnet switch", () => {
  const FULL = {
    ARC_NETWORK: "mainnet",
    ARC_MAINNET_CHAIN_ID: "9999",
    ARC_MAINNET_RPC_URL: "https://rpc.example-arc.invalid",
    ARC_MAINNET_EXPLORER: "https://arcscan.example.invalid",
    ARC_MAINNET_USDC: "0x1111111111111111111111111111111111111111",
    ARC_MAINNET_GATEWAY_WALLET: "0x2222222222222222222222222222222222222222",
    ARC_MAINNET_IDENTITY_REGISTRY: "0x3333333333333333333333333333333333333333",
    ARC_MAINNET_REPUTATION_REGISTRY: "0x4444444444444444444444444444444444444444",
    ARC_MAINNET_VALIDATION_REGISTRY: "0x5555555555555555555555555555555555555555",
    ARC_MAINNET_MEMO: "0x6666666666666666666666666666666666666666",
    ARC_MAINNET_MULTICALL3FROM: "0x7777777777777777777777777777777777777777",
    ARC_MAINNET_GATEWAY_CHAIN: "arc",
  };

  it("moves the whole profile onto the configured chain", async () => {
    const { ARC, chainLabel } = await freshArc(FULL);
    expect(ARC.name).toBe("mainnet");
    expect(ARC.chainId).toBe(9999);
    expect(ARC.network).toBe("eip155:9999");
    expect(ARC.rpcUrl).toBe("https://rpc.example-arc.invalid");
    expect(ARC.usdc).toBe("0x1111111111111111111111111111111111111111");
    expect(ARC.gatewayChainName).toBe("arc");
    expect(ARC.isTestnet).toBe(false);
    expect(chainLabel()).toBe("Arc 9999");
    // No testnet value may leak through.
    expect(JSON.stringify(ARC)).not.toContain("5042002");
    expect(JSON.stringify(ARC)).not.toContain("testnet.arc");
  });

  it("builds a viem chain from the configured values", async () => {
    const { arcChain } = await freshArc(FULL);
    const c = arcChain();
    expect(c.id).toBe(9999);
    expect(c.rpcUrls.default.http).toEqual(["https://rpc.example-arc.invalid"]);
    expect(c.blockExplorers?.default.url).toBe("https://arcscan.example.invalid");
  });

  it("reports itself settlement-ready only when chain, RPC and USDC are all present", async () => {
    const { mainnetReadiness } = await freshArc(FULL);
    const r = mainnetReadiness();
    expect(r.network).toBe("mainnet");
    expect(r.settlementReady).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("keeps the chain-invariant addresses without asking for them", async () => {
    // Multicall3's canonical CREATE2 address and the EIP-7708 system emitter are the same on any EVM chain,
    // so requiring them as mainnet config would be busywork that invites a typo.
    const { ARC } = await freshArc(FULL);
    expect(ARC.multicall3).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
    expect(ARC.systemTransferEmitter).toBe("0xfffffffffffffffffffffffffffffffffffffffe");
  });
});

describe("an incomplete mainnet configuration", () => {
  it("NEVER substitutes a testnet address for a missing mainnet one", async () => {
    const { ARC } = await freshArc({ ARC_NETWORK: "mainnet" });
    // This is the whole safety property: pointing at mainnet with nothing configured must yield empty values
    // that fail loudly, not testnet values that would send real money to the wrong chain's contracts.
    expect(ARC.usdc).toBe("");
    expect(ARC.chainId).toBe(0);
    expect(ARC.rpcUrl).toBe("");
    expect(ARC.memo).toBe("");
    expect(ARC.gatewayChainName).toBeNull();
    expect(JSON.stringify(ARC)).not.toContain("0x3600000000000000000000000000000000000000");
  });

  it("says it is not settlement-ready, and names the env var for each missing value", async () => {
    const { mainnetReadiness } = await freshArc({ ARC_NETWORK: "mainnet" });
    const r = mainnetReadiness();
    expect(r.settlementReady).toBe(false);
    const byField = Object.fromEntries(r.missing.map((m) => [m.field, m.env]));
    expect(byField.chainId).toBe("ARC_MAINNET_CHAIN_ID");
    expect(byField.rpcUrl).toBe("ARC_MAINNET_RPC_URL");
    expect(byField.usdc).toBe("ARC_MAINNET_USDC");
    expect(byField.memo).toBe("ARC_MAINNET_MEMO");
    // Every entry explains what it gates, so an operator can decide what they actually need.
    expect(r.missing.every((m) => m.gates.length > 0)).toBe(true);
    expect(r.note).toMatch(/will not substitute testnet addresses/i);
  });

  it("is settlement-ready on the core three even when optional features are unconfigured", async () => {
    const { mainnetReadiness } = await freshArc({
      ARC_NETWORK: "mainnet",
      ARC_MAINNET_CHAIN_ID: "9999",
      ARC_MAINNET_RPC_URL: "https://rpc.example-arc.invalid",
      ARC_MAINNET_USDC: "0x1111111111111111111111111111111111111111",
    });
    const r = mainnetReadiness();
    expect(r.settlementReady).toBe(true);
    // …but it still says which features are dark, rather than implying everything works.
    const missing = r.missing.map((m) => m.field);
    expect(missing).toContain("memo");
    expect(missing).toContain("gatewayChainName");
    expect(missing).toContain("identityRegistry");
  });

  it("tells a testnet deployment how to become a mainnet one", async () => {
    const { mainnetReadiness } = await freshArc({ ARC_NETWORK: undefined });
    const r = mainnetReadiness();
    expect(r.network).toBe("testnet");
    expect(r.settlementReady).toBe(true); // testnet is fully configured
    expect(r.note).toMatch(/ARC_NETWORK=mainnet/);
    expect(r.note).toMatch(/no code change/i);
  });
});

describe("network-dependent surfaces follow the profile", () => {
  it("quotes the active chain in x402 payment requirements", async () => {
    vi.resetModules();
    process.env.ARC_NETWORK = "mainnet";
    process.env.ARC_MAINNET_CHAIN_ID = "9999";
    process.env.ARC_MAINNET_USDC = "0x1111111111111111111111111111111111111111";
    process.env.ARC_MAINNET_GATEWAY_WALLET = "0x2222222222222222222222222222222222222222";
    const { withGatewaySeller } = await import("../lib/seller");
    const { NextRequest, NextResponse } = await import("next/server");
    const sell = withGatewaySeller(async () => NextResponse.json({ ok: true }), 0.005, "/api/verify/paid", "0x415Fb8814084bDBC7B6964620Ba5Be5939aD2333");
    const res = await sell(new NextRequest("https://merit.test/api/verify/paid", { method: "POST" }));
    const [accept] = (await res.json()).accepts;
    // A buyer must never be quoted the wrong chain — that is a payment sent into the void.
    expect(accept.network).toBe("eip155:9999");
    expect(accept.asset).toBe("0x1111111111111111111111111111111111111111");
    expect(accept.extra.verifyingContract).toBe("0x2222222222222222222222222222222222222222");
  });

  it("stamps the network into the SIGNED credit file, so testnet numbers can never read as mainnet", async () => {
    const a = await freshArc({ ARC_NETWORK: undefined });
    expect(`arc-${a.ARC.name}-${a.ARC.chainId}`).toBe("arc-testnet-5042002");
    const b = await freshArc({ ARC_NETWORK: "mainnet", ARC_MAINNET_CHAIN_ID: "9999" });
    expect(`arc-${b.ARC.name}-${b.ARC.chainId}`).toBe("arc-mainnet-9999");
  });

  it("pays out to Circle's testnet Gateway domains from testnet, and mainnet domains from mainnet", async () => {
    vi.resetModules();
    delete process.env.ARC_NETWORK;
    const t = await import("../lib/crosschain");
    expect(Object.keys(t.PAYOUT_CHAINS)).toContain("baseSepolia");
    expect(Object.keys(t.PAYOUT_CHAINS)).toContain("arcTestnet");
    expect(Object.keys(t.PAYOUT_CHAINS)).not.toContain("base");

    vi.resetModules();
    process.env.ARC_NETWORK = "mainnet";
    process.env.ARC_MAINNET_CHAIN_ID = "9999";
    process.env.ARC_MAINNET_GATEWAY_CHAIN = "arc";
    const m = await import("../lib/crosschain");
    // Burning on a testnet domain and minting on a mainnet one is a failed transfer, not a degraded one.
    expect(Object.keys(m.PAYOUT_CHAINS)).toContain("base");
    expect(Object.keys(m.PAYOUT_CHAINS)).toContain("arc");
    expect(Object.keys(m.PAYOUT_CHAINS)).not.toContain("baseSepolia");
  });
});
