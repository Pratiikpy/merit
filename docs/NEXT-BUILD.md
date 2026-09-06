# The Arc-native settlement layer — built and verified

Four Arc primitives Merit was not using. All four are now shipped, and each was verified against a real
Arc testnet with real (testnet) USDC rather than by reading the docs. Reproduce the whole thing with:

```
npm run verify-arc-native            # 32 checks, real payouts, real chain reads
```

Merit already used: x402, ERC-8004 (all three registries), ERC-8183 + hook-gated escrow, Circle Gateway,
Circle DCW custody, Circle Compliance Engine (KYT), CCTP, AP2, 0G TEE jury. These four were the gap, and
they are Arc-exclusive — VerityLayer (Base) and AgentOracle (SKALE) cannot copy them.

---

## 1. Transaction memos — the verdict travels inside the payment

`Memo` @ [`0x5294E9927c3306DcBaDb03fe70b92e01cCede505`](https://testnet.arcscan.app/address/0x5294E9927c3306DcBaDb03fe70b92e01cCede505)

```solidity
function memo(address target, bytes calldata data, bytes32 memoId, bytes calldata memoData) external;
```

It wraps the call through Arc's `CallFrom` precompile, so USDC still sees the operator EOA as `msg.sender`,
and emits `Memo(sender, target, callDataHash, memoId, memo, memoIndex)`.

**Why it was the most on-thesis thing left.** Merit's claim is *"the payment is the proof"* — but the proof
was a signed JSON served by onmerit.xyz while the USDC transfer was a bare ERC-20 call carrying none of it.
Now `memoId` is derived from the payout's own settlement digest and `memoData` names the `verificationId`s
behind the money. The receipt is an indexed on-chain event anyone can query, with no trust in Merit at all.

Built in `lib/memo.ts`, wired into both real payout paths (`lib/custody.ts` `claimCustody`, `lib/balance.ts`
`withdrawBalance`) and read back by `GET /api/memo` and `/reconcile.html`.

Design decisions worth keeping:

- **`callDataHash` is the binding.** A reader recomputes `keccak256(encodeFunctionData(transfer,[to,atomic]))`
  and it must equal the event field — so a memo cannot be stapled onto a different transfer.
- **`memoId` is derived, not asserted.** `keccak256("merit/<kind>:<id>:<digest>")`, so it can be recomputed
  from the payload the memo itself carries.
- **Truncation never hides anything.** The id list is trimmed to a 480-byte budget (calldata costs 16 gas per
  non-zero byte), but `dig` always covers the full set and `n` states how many refs it covers.
- **The fallback is reported, never silent.** If the memo path cannot pre-flight, the money still moves as a
  plain transfer and the response says so in `memoNote`. `ARC_MEMO=0` disables memos entirely.
- **EOA only.** Both contracts reject smart-contract wallets as the direct caller; a future SCA payout path
  falls back automatically.

Cost: 92,672 gas memoed vs 70,331 plain for a single transfer — about 32% more, for an on-chain receipt.

## 2. Batched payouts with sender preservation

`Multicall3From` @ [`0x522fAf9A91c41c443c66765030741e4AaCe147D0`](https://testnet.arcscan.app/address/0x522fAf9A91c41c443c66765030741e4AaCe147D0)

A domain usually holds more than one custodial balance — the source itself plus a `split:` entry per
co-author. `claimCustodyBatch` settles them in ONE transaction via `aggregate3`, each line wrapped in its own
`Memo` call (nested `CallFrom`, confirmed working on chain). `allowFailure: false` throughout: a half-paid
verified basket would leave the ledger and the chain disagreeing, and a clean retry is strictly better.

Measured: 2 creators, 1 transaction, 114,201 gas, 2 USDC `Transfer` logs, 2 `Memo` events, and
`Transfer.from` still the operator EOA on both — sender preservation held through *two* nested wrappers.

## 3. The ledger, audited against Arc

`lib/reconcile.ts` + `GET /api/reconcile` + `/reconcile.html`. Two directions, both necessary:

- **ledger → chain.** Every published settlement with a real tx hash is re-read from Arc: did it succeed, did
  USDC of that size move, and do Arc's two USDC emitters agree? The native system emitter
  (`0xffff…fffe`, EIP-7708, **18 decimals**) logs every movement including the ones behind the 6-decimal
  ERC-20 interface, so a single `transfer()` emits both. Match on the emitter or you double-count; never mix
  the precisions. 1 ERC-20 atomic unit == 1e12 system units, checked exactly.
- **chain → ledger.** A bounded scan of outbound USDC from the settlement wallet, flagging anything the ledger
  does not explain — the failure ledger-side checking structurally cannot see.

Arc's RPC caps `eth_getLogs` at 10,000 blocks per request (measured; ~86 minutes at Arc's ~0.52 s blocks), so
direction 2 is explicitly a window and every response states its bounds. A clean scan means "nothing
unexplained in this window", never "nothing unexplained ever".

**A real bug this found.** Batched payouts settle several ledger lines to one wallet in one transaction, and
the chain cannot tell those lines apart. Reconciling them individually reported every one as a mismatch
against the batch total — a reporting bug that would have made an honest ledger look falsified.
`groupClaims` now reconciles by `(transaction, payee)`. Regression-tested in
`tests/arc-reconcile-relay.test.ts`.

## 4. Gasless funding (EIP-3009)

`lib/relay.ts` + `GET/POST /api/relay`. Gas on Arc is USDC, so a wallet holding exactly what it means to
spend cannot spend it. The payer signs a `TransferWithAuthorization` and Merit's relayer broadcasts it and
pays the gas. Verified with a wallet whose transaction count stayed at **0** across the transfer.

Verified rather than assumed: Arc USDC's `DOMAIN_SEPARATOR` was read from the contract and matches a locally
recomputed `{name:"USDC", version:"2", chainId:5042002, verifyingContract:0x3600…}` byte for byte. That
constant is pinned in a unit test, so a divergence that would make every relay revert fails in CI rather than
in front of a payer.

Guardrails enforced before broadcast, so a doomed relay costs nothing:

- replay — `authorizationState(from, nonce)` must be false (a replay returns 409)
- time window — checked against the **chain's** clock, not the server's
- the Arc quirk — a full drain of a brand-new account (zero nonce, no code) currently reverts on Arc, so it is
  detected and explained instead of burning gas
- compliance — both `from` and `to` are screened; a blocklisted party reverts at runtime and burns our gas
- a final `eth_call` dry run — a redirected authorization fails here with `FiatTokenV2: invalid signature`

The relay costs Merit ~0.0023 USDC of gas per transfer, reported in the response as `gasPaidUsdc`.

---

## What was verified, and what was not

Verified on Arc testnet on 2026-09-06, 32/32 checks (`npm run verify-arc-native`): batched claim through the
real `POST /api/claim` route with a real domain passport; the payee's real USDC balance rising by exactly the
claimed amount; both memos auditing clean; sender preservation through two wrappers; both emitters agreeing;
memoId lookup from chain logs; the single-claim path; reconciliation in both directions; gasless funding with
a zero-nonce payer, plus replay, redirect, over-value and expiry rejections.

Also green: 659 unit tests, 50 Playwright checks across 5 viewports, and 0 axe violations across the 20
public pages the accessibility sweep covers.

**Not covered.** Arc mainnet (this is testnet only). The Circle DCW payout path is not memoed — it is a
smart-contract wallet, which `CallFrom` rejects by design; that path falls back to a plain transfer and says
so. The outflow scan is a bounded recent window, not all of history. Memo gas was measured for one small
transfer, not profiled across sizes.

## Deliberately not built

- **Arc Privacy Sector (APS).** `docs/PRIVATE-SETTLEMENT.md` anticipates it, but the Arc docs say plainly:
  *"Privacy features are on the roadmap and not yet available on Arc."* Nothing to integrate against.
- **Payments, DEX/AMM, wallets, RWA.** Per `docs/ARC-ECONOMY-RESEARCH.md` §2 these lanes are decisively won
  by funded incumbents. Integrate, do not compete.
