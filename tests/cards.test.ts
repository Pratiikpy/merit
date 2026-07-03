import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import type { Verdict } from "../lib/verify/engine";

let dir: string;
let cards: typeof import("../lib/cards");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-cards-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE; // local-file store
  process.env.STUB = "1";
  cards = await import("../lib/cards");
});

function mkVerdict(over: Partial<Verdict> = {}): Verdict {
  return {
    schema: "merit.cvo/v2",
    engineVersion: "merit-verify/0.1.0",
    claim: "Cross-border B2B stablecoin settlement crossed $4.1T in 2026.",
    sourceHash: "0xabc",
    verdict: "SUPPORTED",
    grounded: true,
    score: 0.91,
    methods: ["injection-guard", "numeric", "nli", "llm-judge"],
    reason: "Source supports the claim.",
    modelTag: "vectara/hallucination_evaluation_model",
    verifiedAt: new Date(0).toISOString(),
    gates: {
      numeric: { ran: true, pass: true, detail: "every number checks out" },
      nli: { ran: true, score: 0.91, pass: true, detail: "0.910 ≥ 0.75" },
      judge: { ran: true, verdict: "support", reason: "the source supports the claim" },
    },
    signer: "0x1111111111111111111111111111111111111111",
    signature: "0xsig",
    ...over,
  };
}

describe("shareable verification cards", () => {
  it("mints short, unique, url-safe ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => cards.newCardId()));
    expect(ids.size).toBe(500); // no collisions across 500 mints
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
      expect(id.length).toBeLessThanOrEqual(11);
      expect(/^[0-9a-z]+$/.test(id)).toBe(true); // base36, url-safe
    }
  });

  it("builds a verify card from a verdict, carrying the gates + truncating the source preview", () => {
    const v = mkVerdict();
    const card = cards.cardFromVerdict(v, { source: "S".repeat(2000), createdAt: v.verifiedAt });
    expect(card.kind).toBe("verify");
    expect(card.claim).toBe(v.claim);
    expect(card.verdict).toBe("SUPPORTED");
    expect(card.sourcePreview.length).toBe(600); // capped preview, never the whole source
    expect(card.gates?.numeric.pass).toBe(true);
    expect(card.signer).toBe(v.signer);
    expect(card.paidUsdc).toBeUndefined();
  });

  it("saves, fetches, counts, and lists newest-first", () => {
    const before = cards.cardCount();
    const a = cards.saveCard(cards.cardFromVerdict(mkVerdict({ claim: "A" }), { source: "sa", createdAt: new Date(1).toISOString() }));
    const b = cards.saveCard(cards.cardFromVerdict(mkVerdict({ claim: "B" }), { source: "sb", createdAt: new Date(2).toISOString() }));
    expect(cards.cardCount()).toBe(before + 2);
    expect(cards.getCard(a.id)?.claim).toBe("A");
    expect(cards.getCard(b.id)?.claim).toBe("B");
    const recent = cards.listCards(2);
    expect(recent[0].id).toBe(b.id); // newest first
    expect(recent[1].id).toBe(a.id);
  });

  it("records a settlement card with the paid amount + tx, and filters by kind", () => {
    const card = cards.saveCard(
      cards.cardFromVerdict(mkVerdict({ claim: "paid one" }), {
        kind: "settlement",
        source: "src",
        sourceName: "StableData API",
        paidUsdc: 0.009,
        tx: "0xdeadbeef",
        explorerUrl: "https://explorer/tx/0xdeadbeef",
        createdAt: new Date(3).toISOString(),
      }),
    );
    expect(card.kind).toBe("settlement");
    expect(card.paidUsdc).toBeCloseTo(0.009, 6);
    expect(card.custody).toBeUndefined(); // a real on-chain settle is never flagged custody
    const settlements = cards.listCards(10, "settlement");
    expect(settlements.every((c) => c.kind === "settlement")).toBe(true);
    expect(settlements.some((c) => c.id === card.id)).toBe(true);
    const verifies = cards.listCards(10, "verify");
    expect(verifies.some((c) => c.id === card.id)).toBe(false);
  });

  it("carries the custody flag so an accrual is never rendered as an on-chain settle", () => {
    const card = cards.cardFromVerdict(mkVerdict({ claim: "custodial one" }), {
      kind: "settlement",
      source: "src",
      sourceName: "Wallet-less Creator",
      paidUsdc: 0.02,
      custody: true,
      createdAt: new Date(4).toISOString(),
    });
    expect(card.custody).toBe(true);
    expect(card.paidUsdc).toBeCloseTo(0.02, 6);
    expect(card.tx).toBeUndefined(); // custody moved no on-chain money
  });

  it("getCard returns undefined for an unknown or empty id", () => {
    expect(cards.getCard("nope-not-here")).toBeUndefined();
    expect(cards.getCard("")).toBeUndefined();
  });

  it("carries the full signed body so signedReceipt recovers the exact signer OFFLINE", async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { recoverMessageAddress } = await import("viem");
    const { canonicalize, signReceiptWith } = await import("../lib/receipt");
    const pk = "0x" + "7".repeat(64);
    const account = privateKeyToAccount(pk as `0x${string}`);

    // Build the EXACT 12-field signed body, sign it, and mint a card from the resulting verdict.
    const body: Verdict = mkVerdict({ claim: "Signed-receipt recovery must be real.", signer: undefined, signature: undefined });
    const { signer, signature } = await signReceiptWith(pk, body);
    const v: Verdict = { ...body, signer, signature };
    const card = cards.saveCard(cards.cardFromVerdict(v, { source: "the source text", createdAt: new Date(9).toISOString() }));

    const signed = cards.signedReceipt(card);
    expect(signed).not.toBeNull();
    // The reconstructed object recovers the same address a third party would, trusting no server.
    const { signer: s, signature: sg, ...rest } = signed as Record<string, unknown> & { signer: string; signature: string };
    const recovered = await recoverMessageAddress({ message: canonicalize(rest), signature: sg as `0x${string}` });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    expect((s as string).toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("derives a stable, tamper-evident verificationId (the join key) and carries it on the card", async () => {
    const { verificationId } = await import("../lib/receipt");
    const v = mkVerdict({ claim: "join key stability test" });
    const id1 = verificationId(v);
    expect(id1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(verificationId({ ...v })).toBe(id1); // same content → same id (deterministic)
    // any change to the verdict changes the id (tamper-evident)
    expect(verificationId({ ...v, verdict: "SUPPORTED" })).not.toBe(verificationId({ ...v, verdict: "REFUSED" }));
    expect(verificationId({ ...v, score: 0.5 })).not.toBe(id1);
    // the card carries the join key
    const card = cards.cardFromVerdict({ ...v, verificationId: id1 }, { source: "s", createdAt: v.verifiedAt });
    expect(card.verificationId).toBe(id1);
  });

  it("signedReceipt returns null when the card is unsigned or predates full-body storage", () => {
    const unsigned = cards.cardFromVerdict(mkVerdict({ signer: undefined, signature: undefined }), { source: "s", createdAt: new Date(10).toISOString() });
    expect(cards.signedReceipt(unsigned)).toBeNull();
    // an old card that has a signature but not the four extra signed fields is honestly not offline-verifiable
    const partial = { ...cards.cardFromVerdict(mkVerdict(), { source: "s", createdAt: new Date(11).toISOString() }), sourceHash: undefined };
    expect(cards.signedReceipt(partial as import("../lib/cards").VerifyCard)).toBeNull();
  });
});
