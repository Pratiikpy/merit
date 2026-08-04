# Private verified settlement — the shielded path (design)

**Status: designed, integration-seam identified, waiting on one dependency — Arc Privacy Sector reaching the
public testnet.** Everything below is buildable the day shielding is callable; nothing here ships half-wired.

## The idea

Arc is bringing a Privacy Sector (shielding/unshielding of balances and transfers, demoed publicly by the Arc
team). Every other payment rail will use it the obvious way: hide the amounts. Merit can do something no one
else can: **keep the verdict public while shielding the money.**

> *Public:* this claim was verified SUPPORTED by the four-gate oracle at this time — signed, replayable,
> auditable by anyone.
> *Private:* how much was paid for it, and to whom.

That combination — provable correctness with confidential economics — is what an enterprise actually wants: an
auditor can confirm every dollar moved only for verified work (the verification chain + the signed statement),
without the vendor's price sheet leaking on a block explorer. "Verified but confidential" is a category no
pay-per-crawl or agent-payment rail can enter, because none of them have a public verdict to anchor trust to
once the amount is hidden.

## How it composes with what already exists

The design threads the existing `verificationId` join key through the shielded leg:

1. **Verify (public, unchanged).** The claim runs the oracle; the signed verdict + `verificationId` land on
   the public record exactly as today (audit chain, `/proof` ledger, statement).
2. **Settle (shielded).** Instead of the transparent USDC transfer, the payer moves the toll inside the
   Privacy Sector: shield → private transfer → (payee later unshields). The public ledger entry records the
   settlement's *existence* and its `verificationId` — not its amount or payee.
3. **Bind (the Merit part).** The private transfer's memo/commitment carries `verificationId`, so the payee
   (and any party they choose to disclose to) can prove *this exact shielded payment settled that exact
   verified claim*. Selective disclosure: the payee can reveal the note to an auditor without making it public.
4. **Account (honest aggregates).** The verified-spend statement gains a `shielded` bucket: counts and
   verification splits stay exact and public; shielded amounts appear as totals-by-disclosure-policy, never
   silently mixed into transparent totals.

## Integration seam (where the code changes when the dependency lands)

- `lib/pay.ts` / `lib/job.ts` — a `settleShielded()` sibling next to the transparent settle: same inputs
  (`payee`, `amount`, `verificationId`), routed to the Privacy Sector's shield/transfer calls.
- `lib/ledger.ts` — entries gain `visibility: "transparent" | "shielded"`; the monotonic cumulative counters
  count both, amount-aggregates split by visibility (the credit file's honesty label already anticipates this).
- `lib/statement.ts` — the statement reports the shielded bucket separately; the refusal-rate headline is
  unaffected (verdicts are public either way).
- `MeritVerificationHook` — unchanged: the hook gates on the verdict, which stays public. If the Privacy
  Sector exposes a hookable settlement path, the same `NotVerified` revert applies to shielded jobs.

## What we will NOT do

- No amount-hiding without the public verdict anchor (that's just another private payment).
- No pretending this is live before the Privacy Sector is publicly callable on testnet — this document is the
  complete design, and the feature ships when the dependency does.

---

# Unified Balance — position (so nobody re-solves this)

Circle's Unified Balance Kit (`@circle-fin/provider-gateway-v1`, App Kit family) manages a unified USDC
balance across chains with a greedy per-chain allocator. **Merit already has this capability through its
production Gateway integration** (`@circle-fin/x402-batching`): the buyer deposits once into a Gateway
balance, spends it in sub-cent x402 settlements on Arc, and withdraws to Base / Arbitrum / Optimism /
Avalanche (`/api/crosschain`, live). Adding the App-Kit provider today would be a second client for the same
rail — duplication, not capability.

**When it becomes worth adopting:** the moment Merit ships a client-side wallet UX (end-users holding their
own balances in the browser) rather than server-held principal balances — that's the surface the App Kit is
built for. Until then, the Gateway client remains the single settlement path.
