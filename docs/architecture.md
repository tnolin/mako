# Architecture

MAKO sends real-time alerts for memecoins, NFTs and DeFi positions on Ink to Telegram and Discord. It reads normalized events from [ink-indexer](https://github.com/tnolin/ink-indexer) and turns them into alerts, cards and menus. The protocols it covers are listed in ink-indexer's [event sources](https://github.com/tnolin/ink-indexer/blob/main/docs/architecture.md#event-sources).

## Users

| User | Where | What they want |
| --- | --- | --- |
| Memecoin trader | Telegram DMs and alpha groups | Know early when a token is moving on its curve, close to bonding, or just bonded |
| NFT collector | Discord, some Telegram | Sales, new listings, floor moves |
| Group owner | Their own Telegram group or Discord server | A configurable feed in their channel, filtered to what their members care about |

## Flow

```text
 ink-indexer: Postgres `events` table
                │
                ▼
 ┌──────────────────────────────┐
 │  src/rules                   │  subscriptions, presets,
 │  match events to subscribers │  thresholds, dedupe, cooldowns
 └──────────────────────────────┘
                │
                ▼
 ┌──────────────────────────────┐
 │  src/cards                   │  one platform-neutral payload
 └──────────────────────────────┘
                │
                ▼
 ┌──────────────────────────────┐
 │  src/delivery                │  queue, per-destination throttles,
 │                              │  digests, deliveries log
 └──────────────────────────────┘
          │               │
          ▼               ▼
  platforms/telegram   platforms/discord
  (grammY, HTML,       (discord.js, embeds,
   inline keyboards)    buttons, selects)
```

Rules and delivery don't depend on any chat platform. Each adapter renders the same payload, so supporting a new platform means writing one adapter.

## Alerts

Users choose alerts through a button setup flow on first start.

1. `/start` opens a welcome card: Pick a preset, Customize, Skip.
2. Presets apply a starting set: Bond hunter, Creator watch, Collector, Quiet (bonds and watchlist only).
3. Customize shows alert groups (Memecoins, NFTs, Wallets), each alert with a toggle and a threshold picker.
4. Settings stay editable from the main menu.

**Memecoins**

| Alert | Fires when | Phase |
| --- | --- | --- |
| Curve progress | A token crosses a progress mark on its curve (e.g. 50%, 80%) | v0 |
| Curve velocity | Progress jumps fast inside a short window | v0 |
| Bonded / graduated | A token bonds or graduates from its launchpad curve | v0 |
| Creator sell | The launch's creator wallet sells its token | v0 |
| Big buy / sell | A single trade above a size threshold | v0 |
| New launch | A new token is created, filterable by launchpad and quote asset | v0 |
| Market cap target | A watched token reaches a user-set market cap | v1 |
| Price move | A bonded token moves by a set percent inside a window | v1 |
| Serial deployer launch | A wallet with past launches deploys a new token | v1 |
| Whale buy | A wallet already holding a large share buys more | v1 |
| Top holder exit | A top 10 holder sells most of their position | v1 |
| Volume spike | Volume runs well above the recent average | v1 |
| Holder milestone | A token passes 100, 500 or 1,000 holders | v1 |
| King / Emperor of the INK | InkyPump's King of the INK or daily Emperor changes | v1 |

**NFTs**

| Alert | Fires when | Phase |
| --- | --- | --- |
| Sale | A sale in a followed collection above a minimum price | v0 |
| Cheap listing | An item lists a set percent under floor | v0 |
| Floor move | Floor changes by a set percent in 24 hours | v0 |
| Rare listing | A high-rarity item lists near floor | v1 |
| Sweep | One wallet buys several items in a short window | v1 |
| New collection | A new Ink collection appears or starts minting | v1 |
| Mint progress | A minting collection passes 50%, 90% or sells out | v1 |

**Wallets and lending**

| Alert | Fires when | Phase |
| --- | --- | --- |
| Health factor | A watched lending position falls below a set level | v0 |
| Liquidation | A watched lending position is liquidated | v0 |
| Wallet activity | A followed wallet buys, sells or launches | v1 |

**Dedupe:** one alert per token per threshold. Velocity and price move alerts have a per-token cooldown. A bond alert replaces any pending progress alert for that token.

**Creator sell:** a sell by the launch's creator wallet fires DEV SELL, with realized PnL from the creator's curve trades and the creator's current share of supply.

## Interaction design

Buttons are the main interface, and slash commands open the same screens for people who prefer typing. Pasting a contract address opens its card.

**Main menu** (`/start`, `/menu`, or the pinned Menu button)

| Row | Buttons |
| --- | --- |
| 1 | Look up token |
| 2 | Hot now · Near bonding · Just bonded |
| 3 | NFTs · Wallets · Lending |
| 4 | My watchlist · My alerts · Presets |
| 5 | Settings · Help · Community |

**Token card buttons:** Watch, Holders, Dev history, Chart, Refresh, Open on launchpad, Explorer.
**NFT card buttons:** Follow collection, Floor, Rarity (v1), Recent sales, Open on marketplace.
**Group admin panel** (`/setup`): Feeds, Thresholds, Minimum sizes, Quiet hours, Hourly cap, Card layout.

**Commands**

| Group | Commands |
| --- | --- |
| Lookup | `/t <address>` card · `/dev <address>` deployer history (v1) · `/hs <address>` holder stats (v1) · `/c <address>` card with chart (v2) |
| Discovery | `/hot` · `/near` · `/bonded` · `/new` · `/koti` · `/stocks` (v1) |
| NFTs | `/nft <collection>` · `/floor <collection>` · `/sales <collection>` · `/rarity <collection> <id>` (v1) · `/mints` (v1) |
| Personal | `/watch <address> [mcap]` · `/follow <collection>` · `/wallet <address>` · `/alerts` · `/presets` · `/health <wallet>` |
| Group admin | `/setup` · `/feeds` · `/quiet` · `/minsize` · `/settings` |
| Utility | `/start` · `/menu` · `/help` · `/status` · `/feedback <text>` |

**Token card**

1. Header: ticker, name, launchpad, phase (curve or bonded).
2. Curve progress bar as text, e.g. `■■■■■■■□□□ 72%`.
3. Market cap, 1h volume, holders, age.
4. Creator line: creator wallet and whether it has sold.
5. Button rows.
6. Footer: bot name and community link.

When the token has an image, the card is the caption of a square photo.

**NFT card:** image, name and rank (v1), price in ETH and USD, discount to floor, seller and buyer short addresses, then buttons.

**Platforms:** Telegram uses HTML messages with inline keyboards and edits the same message as people navigate. Discord uses embeds with a colored side bar, buttons and select menus, with ephemeral replies for personal screens.

## Data model

The bot owns the `bot` schema in the same Postgres as the indexer. It reads only `indexer.events` and `indexer.cursors` (ADR 0006).

| Table | Purpose |
| --- | --- |
| `users` | One row per Telegram user: numeric id, settings (JSON), blocked time |
| `chats` | Groups and channels the bot serves: Telegram chat id, kind, owner, settings (JSON), active flag |
| `subscriptions` | A user's watched tokens and muted tokens |
| `deliveries` | The send queue, the dedupe record and the source for usage metrics |
| `delivery_daily` | Daily delivery counts by alert, chat type and status, rolled up from rows older than 90 days |
| `commands_daily` | Daily command counts |
| `user_actions` | Button and command events with no user column, for product metrics |
| `notices` | Admin notices already sent to a chat, one per reason |
| `state` | Key-value state such as poller cursors |

## Reliability

- Presets keep new users on a focused set of alerts.
- Per-group minimum trade sizes, quiet hours, and an hourly cap that rolls extra alerts into one digest.
- Every send goes through a queue with per-destination throttles. Telegram allows about 30 messages per second overall and about 20 per minute to one group; Discord has per-route limits. A group over budget gets one summary message.
- Alerts older than 3 minutes (30 for DEV SELL and BONDED) are dropped from the queue and counted in one summary message per chat.
- Group feed settings are admin-only.
- Secrets live in env vars. A secret scanner runs in CI.

## Links and referrals

Outbound trade and marketplace links carry referral codes where the platform offers one (InkyPump, Nado). The About page lists these partnerships. MAKO is informational; the About page and terms state this once for the whole service.

## Brand

- **Name:** plain MAKO in handles and domains. Stylized forms appear only in designs and display names.
- **Mark:** the ASCII shark fin.
- **Style:** retro sci-fi cassette futurism: CRT glow, scanlines, radar HUD, ASCII and pixel details.
- **Alerts:** plain text on both platforms for speed.
- Ink projects' names and logos appear in MAKO's branding only with their permission.

## Credits

MAKO's design borrows from these bots: Rick (onboarding, lookups, deployer history), Rarity Sniper (rare listing alerts), Bobby Buy Bot (group feeds), Fomo Eye (watchlists), and [PumpKit](https://github.com/nirholas/pumpkit) (grammY bot structure).

## Decisions

Dated decision records live in [`adr/`](./adr).
