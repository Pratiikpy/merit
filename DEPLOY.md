# Deploying Merit

Merit needs a **long-lived Node server** — the agent run streams over SSE for
20–40s and settles real USDC, so it must NOT run on a serverless function with a
short timeout. Any always-on Node host works (Render, Railway, Fly, a VM).

The agent's x402 endpoints are called over the host's own loopback
(`localhost:$PORT`), so **no `BASE_URL` is needed** — `next start` binds `$PORT`
and the agent self-calls it. The target is fixed to the loopback (never derived from the
request `Host`), so a forged header can't steer the agent's calls off-server.

## Option A — Render (no Docker)
1. Push this `app/` folder to a Git repo.
2. New → **Blueprint**, point it at the repo (it reads `render.yaml`).
3. In the dashboard, set the secret env vars (marked `sync: false`):
   `BUYER_PRIVATE_KEY`, `BUYER_ADDRESS`, `OPERATOR_PRIVATE_KEY`, `OPERATOR_ADDRESS`,
   `SELLER_ADDRESS`, `SELLER_PRIVATE_KEY`, `LLM_API_KEY`.
4. Deploy. Health check hits `/api/health`. The blueprint provisions a small
   **persistent disk** at `/var/merit-data` (`MERIT_DATA_DIR`) so state survives
   redeploys — delete that block in `render.yaml` to run ephemeral instead.

## Option B — Railway / Fly / any Docker host
A `Dockerfile` is included (Node 22, `next start`).
- Railway: New Project → Deploy from repo (auto-detects the Dockerfile). Add the
  same env vars.
- Fly: `fly launch` (uses the Dockerfile), `fly secrets set KEY=…` for each secret.

## Required environment
| var | value |
|---|---|
| `STUB` | `0` (live on-chain) |
| `REPUTATION_ONCHAIN` | `1` (write ERC-8004) or `0` for faster runs |
| `ARC_RPC_URL` | `https://rpc.testnet.arc.network` |
| `BUYER_PRIVATE_KEY` / `BUYER_ADDRESS` | funded agent wallet (Gateway deposit + gas) — **secret** |
| `OPERATOR_PRIVATE_KEY` / `OPERATOR_ADDRESS` | identity registrar (needs gas) — **secret** |
| `SELLER_PRIVATE_KEY` / `SELLER_ADDRESS` | x402 facilitator role — **secret** |
| `LLM_API_KEY` | NVIDIA `nvapi-…` (or OpenAI `sk-…`) — **secret** |
| `LLM_BASE_URL` / `LLM_MODEL` / `EMBED_MODEL` / `EMBED_INPUT_TYPE` | provider config |

Optional: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for a durable receipts mirror.

## Before going live
- **Fund the buyer wallet** with Arc-testnet USDC at https://faucet.circle.com
  (covers the Gateway deposit + gas). Fund the **operator** with a little native
  USDC if `REPUTATION_ONCHAIN=1` (identity-mint gas).
- **Run `npm run preflight`** to verify the live config in one shot — it checks the
  env, that each key derives to its declared address, that the wallets are funded
  (gas + USDC), and that the LLM key works, then prints `READY` / `NOT READY`.
- **Warm the identity cache** with one run (`npm run example`, or hit the demo once)
  before showing it. With `REPUTATION_ONCHAIN=1`, the *first* run lazily mints ~9
  ERC-8004 identities on-chain, so it takes ~50s; every run after is ~30s because the
  agentIds are cached + persisted to `.data/`. Warming up avoids a slow first impression.
- State lives in `.data/` (`registry.json` = source wallets + cached agentIds +
  balances/merit; `specialists.json` = the specialist agents' wallets + reputation +
  agentIds; `publishers.json` = per-publisher ERC-8004 identities). The
  Render blueprint mounts a persistent disk for it by default. On Docker hosts
  (Option B), mount a volume and set `MERIT_DATA_DIR` to it for the same
  durability. **Without** a persistent path, `.data/` is ephemeral — the registry
  re-seeds and identities re-mint on the first run after each restart (fine for a
  single-session demo, but reputation won't accrue across redeploys).
- Never commit `.env.local` (it's git-ignored) — set secrets in the host only.
