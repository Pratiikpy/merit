# Merit Trust API — reputation-as-a-service

A portable, public read layer so **any** external agent can check a counterparty's reputation before it
transacts — the "reputation API" revenue line. No auth (reputation is public). Two endpoints:

## `GET /api/trust`

Rank the sources + specialists an agent could transact with, by reputation.

**Query params** (all optional)

| param | values | default | meaning |
|---|---|---|---|
| `kind` | `all` · `source` · `specialist` | `all` | which side of the market |
| `role` | `search` · `write` · `verify` | — | specialists only: filter by role |
| `minMerit` | `0`–`100` | `0` | minimum reputation |
| `limit` | `1`–`100` | `25` | max results |

**Response** `application/json`

```json
{
  "schema": "merit.trust/v1",
  "query": { "kind": "source", "role": null, "minMerit": 80, "limit": 25 },
  "count": 4,
  "results": [
    {
      "kind": "source",
      "id": "stabledata",
      "name": "StableData API",
      "merit": 95,
      "price": 0.009,
      "effectivePrice": 0.01305,
      "verified": true,
      "agentId": "12",
      "reputationUrl": "/api/reputation/12"
    }
  ],
  "note": "Ranked by Merit reputation. Pull the on-chain, recomputable proof for any entry from its reputationUrl."
}
```

Ranking is by cached `merit` (fast discovery), tie-broken by `effectivePrice` (cheaper first). `effectivePrice`
reflects reputation-gated pricing.

## `GET /api/reputation/{agentId}`

The on-chain, **recomputable** proof for one agent — the ERC-8004 ReputationRegistry feedback events
(`{ score, evidence[] }`), the canonical source of truth behind the merit ranking. Reproduce it server-free
with `npm run recompute -- <agentId>`.

## Try it

```
npm run start                 # in one shell
npm run trust -- source 80    # sources with merit ≥ 80, ranked
npm run trust -- specialist   # the hireable specialist market
```
