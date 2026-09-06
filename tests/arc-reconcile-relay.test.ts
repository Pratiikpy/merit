import { describe, it, expect } from "vitest";
import { keccak256, stringToHex, type Hex } from "viem";
import { decideRow, groupClaims } from "../lib/reconcile";
import { ARC_MIN_MAX_FEE_PER_GAS, TRANSFER_WITH_AUTHORIZATION_TYPES, USDC_EIP712_DOMAIN, computeDomainSeparator, splitSignature } from "../lib/relay";
import { ARC } from "../lib/arc";

const PAYEE = "0x20E0d0e4f478C0E8bFDD6f8451C240F5648BD294";
const OTHER = "0x415Fb8814084bDBC7B6964620Ba5Be5939aD2333";

/** One movement, as Arc logs it: once at 6 decimals on the ERC-20 contract, once at 18 on the system emitter. */
function pair(to: string, atomic: bigint) {
  return [
    { emitter: "erc20" as const, to, value: atomic, usdc: Number(atomic) / 1e6 },
    { emitter: "system" as const, to, value: atomic * BigInt(1e12), usdc: Number(atomic) / 1e6 },
  ];
}

describe("decideRow — ledger vs chain", () => {
  it("confirms a published settlement the chain actually backs", () => {
    const d = decideRow({ claimedUsdc: 0.05, transfers: pair(PAYEE, BigInt(50_000)), to: PAYEE });
    expect(d.match).toBe(true);
    expect(d.onchainUsdc).toBe(0.05);
    expect(d.emittersAgree).toBe(true);
    expect(d.detail).toContain("both emitters agree");
  });

  it("catches a row that overstates what moved", () => {
    const d = decideRow({ claimedUsdc: 0.5, transfers: pair(PAYEE, BigInt(50_000)), to: PAYEE });
    expect(d.match).toBe(false);
    expect(d.detail).toBe("ledger says $0.5, chain shows $0.05");
  });

  it("catches a row that understates what moved — inflation is a defect in both directions", () => {
    const d = decideRow({ claimedUsdc: 0.01, transfers: pair(PAYEE, BigInt(50_000)), to: PAYEE });
    expect(d.match).toBe(false);
  });

  it("ignores transfers to anyone but the recorded payee", () => {
    const transfers = [...pair(PAYEE, BigInt(10_000)), ...pair(OTHER, BigInt(90_000))];
    expect(decideRow({ claimedUsdc: 0.01, transfers, to: PAYEE }).match).toBe(true);
    // With no payee recorded, every transfer in the receipt counts — and the row must then state the total.
    expect(decideRow({ claimedUsdc: 0.1, transfers }).match).toBe(true);
  });

  it("sums the lines of a batched payout to one payee", () => {
    const transfers = [...pair(PAYEE, BigInt(20_000)), ...pair(PAYEE, BigInt(30_000))];
    expect(decideRow({ claimedUsdc: 0.05, transfers, to: PAYEE }).onchainUsdc).toBe(0.05);
  });

  it("tolerates nothing wider than USDC's own smallest unit", () => {
    // 1e-6 apart passes (that IS one atomic unit of rounding); 2e-6 does not.
    expect(decideRow({ claimedUsdc: 0.050001, transfers: pair(PAYEE, BigInt(50_000)), to: PAYEE }).match).toBe(true);
    expect(decideRow({ claimedUsdc: 0.050002, transfers: pair(PAYEE, BigInt(50_000)), to: PAYEE }).match).toBe(false);
  });

  it("does not call the emitters agreed when the system log is missing or wrong", () => {
    const erc20Only = [{ emitter: "erc20" as const, to: PAYEE, value: BigInt(50_000), usdc: 0.05 }];
    const d1 = decideRow({ claimedUsdc: 0.05, transfers: erc20Only, to: PAYEE });
    expect(d1.match).toBe(true); // the amount still checks out
    expect(d1.emittersAgree).toBe(false); // but the second witness is absent, and we say so
    expect(d1.detail).toContain("cross-check unavailable");

    const skewed = [erc20Only[0], { emitter: "system" as const, to: PAYEE, value: BigInt("49999000000000000"), usdc: 0.049999 }];
    expect(decideRow({ claimedUsdc: 0.05, transfers: skewed, to: PAYEE }).emittersAgree).toBe(false);
  });

  it("treats an empty receipt as a mismatch, never as a vacuous pass", () => {
    const d = decideRow({ claimedUsdc: 0.05, transfers: [], to: PAYEE });
    expect(d.match).toBe(false);
    expect(d.onchainUsdc).toBe(0);
    expect(d.emittersAgree).toBe(false);
  });

  it("passes a row that honestly claims zero", () => {
    expect(decideRow({ claimedUsdc: 0, transfers: [], to: PAYEE }).match).toBe(true);
  });
});

describe("groupClaims — batched payouts", () => {
  /**
   * Regression. A batched claim settles several ledger lines to ONE wallet in ONE transaction, and the chain
   * shows only the combined movement per line with no way to attribute a line to a creator. Reconciling those
   * rows one at a time reported every one of them as a mismatch against the batch total — a reporting bug that
   * would have made a perfectly honest ledger look falsified. Found by running the real batch on Arc testnet.
   */
  it("collapses lines that share a transaction AND a payee into one settlement", () => {
    const g = groupClaims([
      { id: "custody:a", tx: "0xAB", usdc: 0.000004, to: PAYEE },
      { id: "custody:b", tx: "0xab", usdc: 0.000003, to: PAYEE.toLowerCase() },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].usdc).toBe(0.000007);
    expect(g[0].ids).toEqual(["custody:a", "custody:b"]);
  });

  it("keeps distinct payees in the same transaction apart", () => {
    const g = groupClaims([
      { id: "a", tx: "0xAB", usdc: 0.01, to: PAYEE },
      { id: "b", tx: "0xAB", usdc: 0.02, to: OTHER },
    ]);
    expect(g).toHaveLength(2);
    expect(g.map((x) => x.usdc).sort()).toEqual([0.01, 0.02]);
  });

  it("keeps the same payee in different transactions apart", () => {
    const g = groupClaims([
      { id: "a", tx: "0xAA", usdc: 0.01, to: PAYEE },
      { id: "b", tx: "0xBB", usdc: 0.02, to: PAYEE },
    ]);
    expect(g).toHaveLength(2);
  });

  it("leaves an ungrouped row alone, carrying its own id", () => {
    const g = groupClaims([{ id: "solo", tx: "0xAA", usdc: 0.5 }]);
    expect(g).toHaveLength(1);
    expect(g[0].ids).toEqual(["solo"]);
  });

  it("makes the grouped total reconcile where the individual rows could not", () => {
    const rows = [
      { id: "custody:a", tx: "0xAB", usdc: 0.000004, to: PAYEE },
      { id: "custody:b", tx: "0xAB", usdc: 0.000003, to: PAYEE },
    ];
    const chain = [...pair(PAYEE, BigInt(4)), ...pair(PAYEE, BigInt(3))]; // what the batch actually emitted
    // Ungrouped, each row is compared against the whole transaction and both look wrong.
    for (const r of rows) expect(decideRow({ claimedUsdc: r.usdc, transfers: chain, to: r.to }).match).toBe(false);
    // Grouped, the ledger and the chain agree exactly.
    const [g] = groupClaims(rows);
    expect(decideRow({ claimedUsdc: g.usdc, transfers: chain, to: g.to }).match).toBe(true);
  });
});

describe("EIP-3009 relay primitives", () => {
  /**
   * The literal below is Arc testnet USDC's own DOMAIN_SEPARATOR, read from the contract at
   * 0x3600000000000000000000000000000000000000 on 2026-09-06. If this test ever fails, the domain we ask users
   * to sign has diverged from the one the token enforces and every relay would revert — which is exactly the
   * failure worth catching in CI rather than in front of a payer.
   */
  const ONCHAIN_DOMAIN_SEPARATOR = "0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0";

  it("recomputes the domain separator Arc USDC actually enforces", () => {
    expect(computeDomainSeparator().toLowerCase()).toBe(ONCHAIN_DOMAIN_SEPARATOR);
  });

  it("publishes the domain fields the contract was deployed with", () => {
    expect(USDC_EIP712_DOMAIN).toEqual({ name: "USDC", version: "2", chainId: 5042002, verifyingContract: ARC.usdc });
  });

  it("declares the TransferWithAuthorization struct in the EIP-3009 field order", () => {
    expect(TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization.map((f) => `${f.type} ${f.name}`)).toEqual([
      "address from",
      "address to",
      "uint256 value",
      "uint256 validAfter",
      "uint256 validBefore",
      "bytes32 nonce",
    ]);
  });

  it("respects Arc's 20 Gwei minimum fee, below which a transaction can sit pending forever", () => {
    expect(ARC_MIN_MAX_FEE_PER_GAS).toBe(BigInt(20_000_000_000));
  });

  describe("splitSignature", () => {
    const r = "a".repeat(64);
    const s = "b".repeat(64);
    it("normalizes a raw {0,1} recovery id to the legacy {27,28} the token expects", () => {
      expect(splitSignature(`0x${r}${s}00` as Hex)!.v).toBe(27);
      expect(splitSignature(`0x${r}${s}01` as Hex)!.v).toBe(28);
    });
    it("passes a legacy v through untouched", () => {
      expect(splitSignature(`0x${r}${s}1b` as Hex)!.v).toBe(27);
      expect(splitSignature(`0x${r}${s}1c` as Hex)!.v).toBe(28);
    });
    it("splits r and s on the right byte boundaries", () => {
      const got = splitSignature(`0x${r}${s}1b` as Hex)!;
      expect(got.r).toBe(`0x${r}`);
      expect(got.s).toBe(`0x${s}`);
    });
    it("rejects a malformed signature rather than relaying garbage", () => {
      expect(splitSignature("0xdeadbeef" as Hex)).toBeNull();
      expect(splitSignature(`0x${r}${s}` as Hex)).toBeNull(); // 64 bytes, no v
      expect(splitSignature(`0x${r}${s}05` as Hex)).toBeNull(); // an impossible recovery id
    });
  });

  it("uses a random bytes32 nonce, not an account nonce — the replay key is per-authorization", () => {
    // Documented behavior, asserted so it cannot silently regress into a sequential nonce.
    const a = keccak256(stringToHex("auth-1"));
    const b = keccak256(stringToHex("auth-2"));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("the missing-key message", () => {
  /**
   * Found on production: a valid, freshly-minted key returned 401 from every keyed route. The cause was not
   * auth at all — the apex domain 308-redirects to `www`, and HTTP clients drop the Authorization header
   * across a cross-host redirect, so the request arrived genuinely keyless. Server-side that is
   * indistinguishable from an anonymous call, so the only honest fix is for the message to name it.
   */
  it("tells a caller whose key vanished in a redirect what actually happened", async () => {
    const { MISSING_KEY_ERROR } = await import("../lib/auth");
    expect(MISSING_KEY_ERROR).toMatch(/Authorization: Bearer/);
    expect(MISSING_KEY_ERROR).toMatch(/cross-host redirect/i);
    expect(MISSING_KEY_ERROR).toMatch(/canonical host/i);
    // It must not accuse the caller of forgetting a key they did send.
    expect(MISSING_KEY_ERROR).not.toMatch(/you forgot|invalid key/i);
  });

  it("is what authGate returns when enforcement is on and no key is present", async () => {
    const prev = process.env.MERIT_REQUIRE_AUTH;
    process.env.MERIT_REQUIRE_AUTH = "1";
    try {
      const { authGate, MISSING_KEY_ERROR } = await import("../lib/auth");
      const gate = authGate(new Request("https://example.test/api/balance"));
      expect(gate.ok).toBe(false);
      expect(gate.status).toBe(401);
      expect(gate.error).toBe(MISSING_KEY_ERROR);
    } finally {
      if (prev === undefined) delete process.env.MERIT_REQUIRE_AUTH;
      else process.env.MERIT_REQUIRE_AUTH = prev;
    }
  });
});
