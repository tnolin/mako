# MAKO

![MAKO](docs/images/banner.webp)

[![CI](https://github.com/tnolin/mako/actions/workflows/ci.yml/badge.svg)](https://github.com/tnolin/mako/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Real-time Telegram alerts for memecoins on Ink.

MAKO watches every launch on Ink's launchpads and tells you, in a DM, a group topic or a channel, when a token launches, pumps, nears its bond, bonds, or when its creator sells. You set it up with buttons. It reads normalized events from [ink-indexer](https://github.com/tnolin/ink-indexer).

## Alerts

| Alert | When it fires |
| --- | --- |
| NEW TOKEN | A token launches. When more than 10 launch on one launchpad within 5 minutes, they are grouped into one message per minute until it slows down. |
| BONDING | A token's bonding curve passes 80% or 90%. A 50% mark can be turned on in My alerts. |
| PUMPING | A token's curve rises 15 points or more within 10 minutes. At most once an hour per token in each chat. |
| BONDED | A token fills its curve and its liquidity moves to a Uniswap pool. |
| DEV SELL | The wallet that created a token sells some of it on the curve. |
| BIG BUY / BIG SELL | One trade of 5% or more of the token's bond target. 2.5% or 10% can be chosen in My alerts. |

Each alert can be turned off, and its image hidden, in My alerts. Watched tokens send every alert type except NEW TOKEN to your DM.

## Documentation

- [Architecture](docs/architecture.md)
- [Deployment](docs/deploy.md)
- [Decision records](docs/adr)
- [AGENTS.md](AGENTS.md), for coding agents

<!-- Privacy policy: add the link at https://makobot.xyz once the site is live. -->

## Quick start

    pnpm install
    cp .env.example .env    # set DATABASE_URL (an ink-indexer database), TELEGRAM_BOT_TOKEN and LINKS_BASE_URL
    pnpm start

## What's inside

| Path | What it does |
| --- | --- |
| [`src/rules`](src/rules) | Turns indexer events into alerts: NEW TOKEN, BONDING, PUMPING, BONDED, DEV SELL, BIG BUY/SELL |
| [`src/delivery`](src/delivery) | Queue, per-chat throttling, overflow summaries, admin notices |
| [`src/menus`](src/menus) | Button screens: onboarding, menu, token cards, watchlist, settings, groups and channels |
| [`src/platforms/telegram`](src/platforms/telegram) | grammY bot, HTML rendering, sending |
| [`scripts/deploy`](scripts/deploy) | systemd units, Caddy, backups for a single VPS |

## How it works

```text
 ink-indexer: indexer.events (confirmed)
        │  poll every second
        ▼
 rules ──► cards ──► bot.deliveries (queue) ──► sender ──► Telegram
                                   ▲  per-chat throttles, late drop, summaries
 menus (grammY) ─ settings, watchlist, mutes ─┘
```

## Contributing, security and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). MIT licensed, see [LICENSE](LICENSE).
