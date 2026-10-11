# Publishers on Merit

*15 real public feeds indexed as citable creators. **Honest disclosure:** these are permissionless
listings — real publisher content, not opted in via a `merit-verify:` marker (the same model keryx used for
its public feeds). An owner-verified creator is a stronger signal; this is the open-listing tier.*

**2026-10-11 re-onboarding note:** these 15 were re-registered after an operator error (a registry-mirror
write race, since fixed) wiped the prior entries. They now settle to Merit's own custody wallet rather than
individual receive-only wallets (custodial accrual, claimable via domain proof — see `lib/custody.ts`), and
on-chain ERC-8004 identity minting did not complete for this batch, so they're self-attested rather than
chain-verified for now. One original feed, Paul Graham's essays (`aaronsw.com/2002/feeds/pgessays.rss`), no
longer parses as valid RSS/Atom and could not be re-onboarded.

| publisher | feed |
|---|---|
| Hugging Face - Blog | `huggingface.co/blog/feed.xml` |
| Hacker News: Front Page | `hnrss.org/frontpage` |
| Simon Willison's Weblog | `simonwillison.net/atom/everything/` |
| The Cloudflare Blog | `blog.cloudflare.com/rss/` |
| The GitHub Blog | `github.blog/feed/` |
| The Verge | `www.theverge.com/rss/index.xml` |
| TechCrunch | `techcrunch.com/feed/` |
| Ethereum Foundation Blog | `blog.ethereum.org/en/feed.xml` |
| Krebs on Security | `krebsonsecurity.com/feed/` |
| CoinDesk: Bitcoin, Ethereum, Crypto News and Price Data | `www.coindesk.com/arc/outboundfeeds/rss/` |
| Vitalik Buterin's website | `vitalik.eth.limo/feed.xml` |
| OpenAI News | `openai.com/news/rss.xml` |
| Stack Overflow Blog | `stackoverflow.blog/feed/` |
| WIRED | `www.wired.com/feed/rss` |
| Ars Technica - All content | `feeds.arstechnica.com/arstechnica/index` |

Each earns USDC on Arc when a Merit agent **verifiably** cites its work. Onboard your own at `/onboard.html`.
