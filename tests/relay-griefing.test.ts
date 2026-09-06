import { describe, it, expect, afterEach } from "vitest";
import { decideRelayAllowed, relayMinUsdc } from "../lib/relay";

/**
 * Gas-griefing on the gasless relay.
 *
 * The relay is asymmetric by construction: the payer spends nothing and Merit spends real gas (~0.0023 USDC
 * per relay, measured on Arc). As first shipped it had no rate limit, no minimum and no restriction on the
 * destination — and a Merit API key is free and unlimited from self-serve onboarding. So anyone could mint a
 * key, sign an endless stream of one-atomic-unit authorizations, and drain the relayer's balance a fee at a
 * time: $0.000001 moved for every $0.0023 of ours. Found by reviewing the route against the other
 * money-touching routes, all of which were rate-limited while this one was not.
 *
 * Three guards now: a floor well above the fee, a destination Merit can actually credit, and the same rate
 * limit every other settlement route carries.
 */

const ORIGINAL = process.env.MERIT_RELAY_MIN_USDC;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MERIT_RELAY_MIN_USDC;
  else process.env.MERIT_RELAY_MIN_USDC = ORIGINAL;
});

const MINE = "0xAAaAaA00000000000000000000000000000000aA";
const THEIRS = "0xBBbBbB00000000000000000000000000000000bB";
const base = { minUsdc: 0.01, to: MINE, depositAddress: MINE, openRelay: false };

describe("relayMinUsdc", () => {
  it("defaults to a floor an order of magnitude above the ~0.0023 USDC gas cost", () => {
    delete process.env.MERIT_RELAY_MIN_USDC;
    expect(relayMinUsdc()).toBe(0.01);
    expect(relayMinUsdc()).toBeGreaterThan(0.0023 * 3);
  });

  it("is configurable, but never zero or negative", () => {
    process.env.MERIT_RELAY_MIN_USDC = "0.05";
    expect(relayMinUsdc()).toBe(0.05);
    for (const bad of ["0", "-1", "abc", ""]) {
      process.env.MERIT_RELAY_MIN_USDC = bad;
      expect(relayMinUsdc()).toBe(0.01);
    }
  });
});

describe("decideRelayAllowed", () => {
  it("allows a real top-up into the caller's own deposit address", () => {
    expect(decideRelayAllowed({ ...base, valueUsdc: 1 })).toEqual({ allowed: true });
  });

  it("refuses dust — the griefing vector", () => {
    const d = decideRelayAllowed({ ...base, valueUsdc: 0.000001 });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.status).toBe(400);
    expect(d.error).toMatch(/at least 0\.01 USDC/);
    expect(d.error).toMatch(/Merit pays the gas/);
  });

  it("accepts a transfer exactly at the floor", () => {
    expect(decideRelayAllowed({ ...base, valueUsdc: 0.01 }).allowed).toBe(true);
    // …and tolerates float representation, so a legitimate 0.01 is never rejected by rounding.
    expect(decideRelayAllowed({ ...base, valueUsdc: 0.009999999 }).allowed).toBe(true);
  });

  it("refuses to be a gas faucet for a stranger's transfer", () => {
    const d = decideRelayAllowed({ ...base, valueUsdc: 1, to: THEIRS });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.status).toBe(403);
    expect(d.error).toMatch(/your own deposit address/i);
    // The message names the address the caller should have used, so a legitimate client can self-correct.
    expect(d.error).toContain(MINE);
  });

  it("matches the destination case-insensitively — checksum casing is not a rejection reason", () => {
    expect(decideRelayAllowed({ ...base, valueUsdc: 1, to: MINE.toLowerCase() }).allowed).toBe(true);
    expect(decideRelayAllowed({ ...base, valueUsdc: 1, depositAddress: MINE.toLowerCase() }).allowed).toBe(true);
  });

  it("lets an operator deliberately open the relay, and only then", () => {
    expect(decideRelayAllowed({ ...base, valueUsdc: 1, to: THEIRS, openRelay: true }).allowed).toBe(true);
    // The amount floor still applies — an open relay is not a free one.
    expect(decideRelayAllowed({ ...base, valueUsdc: 0.000001, to: THEIRS, openRelay: true }).allowed).toBe(false);
  });

  it("refuses rather than relaying blind when the deployment has no deposit address", () => {
    const d = decideRelayAllowed({ ...base, valueUsdc: 1, depositAddress: null });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.status).toBe(503);
    expect(d.error).toMatch(/MERIT_WALLET_SEED/);
  });

  it("checks the amount before the destination, so dust is rejected on the cheaper test", () => {
    const d = decideRelayAllowed({ ...base, valueUsdc: 0.000001, to: THEIRS });
    if (d.allowed) throw new Error("unreachable");
    expect(d.status).toBe(400); // the amount complaint, not the destination one
  });
});
