# MAKO

[![CI](https://github.com/tnolin/mako/actions/workflows/ci.yml/badge.svg)](https://github.com/tnolin/mako/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Real-time Telegram alerts for memecoins on Ink.

MAKO watches every launch on Ink's launchpads and tells you, in a DM, a group topic or a channel, when a token launches, pumps, nears its bond, bonds, or when its creator sells. You set it up with buttons. It reads normalized events from [ink-indexer](https://github.com/tnolin/ink-indexer).

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

Decisions are recorded in [`docs/adr`](docs/adr). Deployment is described in [`docs/deploy.md`](docs/deploy.md).

## Contributing, security and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). MIT licensed, see [LICENSE](LICENSE).
