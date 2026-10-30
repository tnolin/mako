# MAKO

![MAKO](docs/images/banner.webp)

[![CI](https://github.com/tnolin/mako/actions/workflows/ci.yml/badge.svg)](https://github.com/tnolin/mako/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

The only bot for real-time alerts of memecoins and NFTs on Ink. Open source. Join the community: @MakoOnInk

It reads normalized events from [ink-indexer](https://github.com/tnolin/ink-indexer).

## Platforms

MAKO currently works with:
- **Ink:** reads launches, trades, mints and sales directly from the chain.
- **InkyPump:** memecoin launches, bonding progress, and trading in each token's Uniswap pool after it bonds.
- **OpenSea:** NFT collection details, floors, listings, rarity ranks and mint schedules. View and Buy buttons open OpenSea.
- **Chimera:** new Chimera-404 collections.

## Alerts

### Token alerts

| Alert | When it fires |
| --- | --- |
| NEW TOKEN | A token launches. When more than 10 launch on one launchpad within 5 minutes, they are grouped into one message per minute until it slows down. |
| BONDING | A token's bonding curve passes 80% or 90%. A 50% mark can be turned on in My alerts. |
| PUMPING | On the curve: the curve rises 15 points or more within 10 minutes, at most once an hour per token in each chat. After bonding: the market cap rises 20% or more over its lowest point in the last 10 minutes (15%, 30% or 50% can be chosen), once until the rise falls back under 5%. Feeds get it from a $50K market cap (adjustable); watched tokens always do. |
| BONDED | A token fills its curve and its liquidity moves to a Uniswap pool. |
| DEV SELL | The wallet that created a token sells some of it, on the curve or in its pool. |
| BIG BUY / BIG SELL | One trade of 5% or more of the token's bond target, or, after bonding, of its pool's liquidity and worth at least $1,000. 2.5% or 10% can be chosen in My alerts. |
| MCAP TARGET | A watched token's market cap reaches the target set with `/watch <token> <amount>`. Sent once, then the target is cleared. |

### NFT alerts

#### All collections

When turned on: Every collection that passes MAKO's quality checks. When turned off: Only receive alerts on NFTs you watch.

| Alert | When it fires |
| --- | --- |
| UPCOMING MINT | When a new mint is scheduled. |
| MINT STARTING | When a mint's public stage opens. |
| MINTED | When a watched collection's total mints has passed your designated threshold (eg. 50% = 50/100 mints). |
| SOLD OUT | When a collection completely mints out. |
| NEW COLLECTION | A new Chimera collection is detected. |
| BIG SALE | When an NFT sells for 0.1 ETH or more. |

#### Watched only

These alerts are only for NFTs you added to your watchlist.

| Alert | When it fires |
| --- | --- |
| UNDER FLOOR | an item lists 20%+ under floor. |
| RARE LISTING | a top 10% item lists near floor. |
| FLOOR MOVE | the floor moves 20%+ in 24h. |
| SWEEP | one wallet buys 5+ items in 10 min. |
| SOLD | an item sells for 0.05 ETH or more. |
| REMINDERS | a message 15 min before each mint stage. |

Each alert can be turned off, and its image hidden, in My alerts. MCAP TARGET has no switch or image setting: it goes only to whoever set the target.

## Watched & Muted

Watching: I'll send you every alert type for tokens or NFTs that you add to your watchlist, even for the alerts turned off. This also includes mint reminders 15 minutes before each mint stage.

Market cap target: `/watch $GOBLO 500k` watches the token and sends MCAP TARGET when its market cap reaches $500K. An amount below the current market cap alerts when it drops to it. Amounts read like `500k`, `1.5m`, `$500k` or `500000`. A new amount replaces the old one, and the Watched tokens list shows it. A token can be named by address, `$TICKER` or name.

Stop watching: It can still appear in your feeds.

Muted: I won't send you any alerts on tokens or NFTs that you mute. If it is on your watchlist, it is removed automatically.

Remind me: These alerts are only for an NFT's upcoming mint stages. Select 'Remind me' if you want to get notifications 15 min before each mint stage without adding the collection to your Watchlist.

## Menus and settings

- **Tokens:** Alerts and lists for tokens launched on Ink.
- **NFTs:** Alerts and lists for NFT collections on Ink.
- **My alerts:** Choose which alerts you want me to send you.
- **Token alerts:** Customize what kind of alerts you receive for tokens.
- **NFT alerts · All collections:** When turned on: Every collection that passes MAKO's quality checks. When turned off: Only receive alerts on NFTs you watch.
- **NFT alerts · Watched only:** These alerts are only for NFTs you added to your watchlist.

Commands:

    /t <address> look up a token
    /watch <token> [mcap] watch a token, with an optional market cap alert
    /nft <collection> [1h|24h|7d|30d]
    /nft <collection> <id> look up one NFT

## Group setup

1. Tap Add to group or channel in the menu, and make MAKO an admin so it can post in topics.
2. In the topic where alerts should go, send /setup. Every alert posts there by default.
3. Want different alerts in different topics? Send /route in another topic and pick which alerts go there.
4. Tap Open settings to choose alerts, thresholds and images. NFT alerts are off in groups until an admin turns them on.

Tips
- Give each alert type its own topic, like New tokens, Bonding and Mints, so chat doesn't bury them.
- Close alert topics so only MAKO can post there.
- In busy groups, turn images off to keep alerts compact.
- Use /watch for the tokens and collections your community cares about, so market alerts stay focused.

## Privacy

MAKO is an open-source project built to store as little data as possible. It does not store personal information like your name, username, phone number or messages. MAKO only stores your Telegram user ID, to remember your notification settings, the tokens and NFTs you watch or mute, your mint reminders, and the alerts queued for you (kept for 90 days).

You can delete your data in Settings → Delete my data. Server backups are deleted after 14 days.

## Documentation

- [Architecture](docs/architecture.md)
- [Deployment](docs/deploy.md)
- [Reliability](docs/reliability.md)
- [Decision records](docs/adr)
- [AGENTS.md](AGENTS.md), for coding agents

## Quick start

    pnpm install
    cp .env.example .env    # set DATABASE_URL (an ink-indexer database), TELEGRAM_BOT_TOKEN and LINKS_BASE_URL; OPENSEA_API_KEY is optional
    pnpm start

## What's inside

| Path | What it does |
| --- | --- |
| [`src/rules`](src/rules) | Turns launchpad events and pool swaps into token alerts: NEW TOKEN, BONDING, PUMPING, BONDED, DEV SELL, BIG BUY/SELL, MCAP TARGET |
| [`src/nft`](src/nft) | Collection state, mint and market rules, watches, mint reminders, OpenSea item reads |
| [`src/delivery`](src/delivery) | Routing, queue, per-chat throttling, overflow summaries, admin notices |
| [`src/menus`](src/menus) | Button screens: menu, Tokens, NFTs, cards, watched and muted lists, alert settings, groups and channels |
| [`src/platforms/telegram`](src/platforms/telegram) | grammY bot, HTML rendering, sending |
| [`scripts/deploy`](scripts/deploy) | systemd units, Caddy, backups for a single VPS |

## How it works

```text
 ink-indexer: indexer.events (confirmed)
        │  poll every second
        ▼
 rules ──► cards ──► bot.deliveries (queue) ──► sender ──► Telegram
 (token rules, NFT rules      ▲  per-chat throttles, late drop, summaries
  over collection state)      │
 menus (grammY) ─ settings, watches, mutes ─┘
```

## Contributing, security and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). MIT licensed, see [LICENSE](LICENSE).
