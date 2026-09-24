# Deploying Merit's contracts to Arc mainnet

Arc mainnet (chain `5042`, RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`) launched in
2026-09. Merit's network layer (`lib/arc.ts`) already targets it — set `ARC_NETWORK=mainnet` plus the
`ARC_MAINNET_*` values in `.env.example` and the whole app moves, no code change. What's still missing is
Merit's own contract suite: MeritJob, MeritVerificationHook, Escrow, Stake, Insurance, PredictionMarket and
AttestationVerifier exist on Arc **testnet only** — mainnet is a separate chain with separate state, so they
have to be deployed there fresh, at new addresses.

Everything below this line — the RPC alias, the script, the gas estimate — has been dry-run against the real
Arc mainnet chain (`forge script … --rpc-url arc_mainnet`, no `--broadcast`), so it's proven to work, not
guessed. Only the actual `--broadcast` needs a funded key and a decision to spend real money.

## What's needed first: real USDC gas

Gas on Arc is paid in USDC (18-decimal native token). There is **no faucet on mainnet** — this is real money,
not testnet play money. The dry-run against the live chain on 2026-09-23 gave:

```
Chain 5042
Estimated gas price: 40.1 gwei
Estimated total gas used for script: 5,890,730   (all 7 contracts, one script run)
Estimated amount required: 0.236218273 USDC
```

Gas price on Arc moves, so fund with headroom — **0.5 USDC is a safe floor**, 1 USDC if you want margin for a
retry. The deployer wallet (`OPERATOR_ADDRESS` in `.env.local`, currently `0x240b90DeD3aCa4728faAdC5123080F0fcBb4bE72`)
holds **0 USDC on Arc mainnet** as of this check — it has real testnet USDC only. Send mainnet USDC to that
address before running the command below.

## Deploy command

From `contracts/`, with `ARC_MAINNET_RPC_URL` set (defaults to the public RPC in `.env.example`) and the
deployer's private key available:

```bash
forge script script/Deploy.s.sol:DeployAll \
  --rpc-url arc_mainnet \
  --broadcast \
  --private-key $OPERATOR_PRIVATE_KEY \
  --verify --verifier blockscout --verifier-url https://explorer.arc.io/api
```

This is the same `DeployAll` script already used for testnet — `OPERATOR_ADDRESS` becomes the
slasher/arbiter/oracle/verdict-recorder role on Stake/Insurance/PredictionMarket/MeritVerificationHook,
`BUYER_ADDRESS` becomes the AttestationVerifier auditor, and USDC defaults to the real mainnet address
(`0x3600…0000` — same address as testnet, confirmed by `eth_getCode`).

**`--verify` is untested against mainnet, not confirmed working — try it, don't assume it.** Testnet
verification (`forge verify-contract --verifier blockscout --verifier-url https://testnet.arcscan.app/api`)
worked. A plain `curl` at the equivalent mainnet path (`https://explorer.arc.io/api` and `/api/v2/...`) returns
a Cloudflare JS challenge page rather than JSON — which may or may not also block forge's verifier requests;
this was only checked with `curl`, not by actually running `--verify` (that needs a real broadcast tx to
verify against, which needs the funding above). If `--verify` fails inline, deploy without it and run
`forge verify-contract <address> <Contract> --verifier blockscout --verifier-url https://explorer.arc.io/api --chain 5042`
per-contract afterward; if that also fails, it is a real external blocker to report (Cloudflare bot protection
on Arc's own mainnet explorer API) — not something to route around by skipping verification silently.

## After deploying

1. Copy the 7 logged addresses into `.env.local` as `MERITJOB_ADDRESS`, `MERIT_HOOK_ADDRESS`,
   `ESCROW_ADDRESS`, `STAKE_ADDRESS`, `INSURANCE_ADDRESS`, `MARKET_ADDRESS`, `ATTEST_ADDRESS`.
2. Write a `contracts/deployments.mainnet.json` mirroring `deployments.json`'s shape (network
   `arc-mainnet`, chain `5042`, explorer `https://explorer.arc.io`).
3. Set `ARC_NETWORK=mainnet` plus the `ARC_MAINNET_*` values from `.env.example` (already filled in with
   live-verified addresses, except the two documented gaps below).
4. Run `npm run verify-arc-native` and `npm run verify-x402-buyer` against mainnet before calling it live —
   the same real-chain, real-payout proof that was required on testnet, not a code-looks-right claim.

## What is genuinely still missing (checked, not guessed)

- **ERC-8004 identity/reputation/validation registries.** No mainnet address anywhere in Arc's docs
  (`docs.arc.io`), and `eth_getCode` at the testnet address returns nothing on mainnet chain 5042 as of
  2026-09-23. ERC-8004 writes stay testnet-only until Circle/the registry deployer ships mainnet addresses —
  Merit reports this as missing rather than substituting the testnet address.
- **Circle Gateway mainnet chain key.** `@circle-fin/x402-batching` 3.5.0+ ships `GATEWAY_DOMAINS.arc = 26` —
  set `ARC_MAINNET_GATEWAY_CHAIN=arc` (already in `.env.example`). This was the actual blocker on the
  previously-pinned 2.1.0, which only had `arcTestnet`; the app now depends on `^3.5.0` and passed the full
  659-test suite against it.
