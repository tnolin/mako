# Architecture

MAKO sends real-time alerts for tokens and NFTs on Ink to Telegram. It reads normalized events from [ink-indexer](https://github.com/tnolin/ink-indexer) and turns them into alerts, cards and menus. The protocols it covers are listed in ink-indexer's [event sources](https://github.com/tnolin/ink-indexer/blob/main/docs/architecture.md#event-sources).

## Users

| User | Where | What they want |
| --- | --- | --- |
| Memecoin trader | Telegram DMs and alpha groups | Know early when a token is moving on its curve, close to bonding, or just bonded |
| NFT collector | Telegram DMs | Mints, sales, floor moves and rare listings for the collections they watch |
| Group owner | Their own Telegram group or channel | A feed in their chat, filtered to what their members care about |

## Flow

```text
 ink-indexer: Postgres `events` table
                │
                ▼
 ┌──────────────────────────────┐
 │  src/rules, src/nft/rules    │  token rules; NFT rules over an in-memory
 │  events to candidate alerts  │  collection state rebuilt up to the cursor
 └──────────────────────────────┘
                │
                ▼
 ┌──────────────────────────────┐
 │  src/delivery/recipients     │  who gets each candidate: feeds, watches,
 │                              │  mutes, thresholds, caps, topics
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
 │                              │  summaries, deliveries log
 └──────────────────────────────┘
                │
                ▼
         platforms/telegram
   (grammY, HTML, inline keyboards)
```

Rules and delivery don't depend on the chat platform. The Telegram adapter renders the payload.

NFT events are applied to the collection state before anything else, so history from the indexer's backfill still builds the state. Rules skip NFT events older than the alerts start time (`NFT_ALERTS_SINCE`, or the time the bot first ran with NFT rules), so backfilled history sends nothing.

## Alerts

Alert settings are edited in the user's DM, for the user and for each group or channel they administer. New users get the menu, then a picker for the token alerts.

**Token alerts**

| Alert | Fires when |
| --- | --- |
| NEW TOKEN | A token is created |
| BONDING | A token's curve passes 80% or 90% (50% is optional) |
| PUMPING | A token's curve rises 15 points within 10 minutes |
| BONDED | A token bonds and its liquidity moves to a pool |
| DEV SELL | The launch's creator wallet sells its token |
| BIG BUY / BIG SELL | One trade of 5% (2.5% or 10%) or more of the bond target |

**NFT alerts, All collections**

| Alert | Fires when |
| --- | --- |
| UPCOMING MINT | A mint is scheduled |
| MINT STARTING | A mint stage opens, other than a Team stage |
| MINT LIVE | A mint without stages goes live |
| MINTED | A collection's mint passes a mark (25%, 50% or 75%) |
| SOLD OUT | A collection mints out |
| NEW COLLECTION | A new Chimera collection has a name and an image |
| BIG SALE | A sale at or above 0.05, 0.1, 0.25 or 0.5 ETH |

**NFT alerts, Watched only**

| Alert | Fires when |
| --- | --- |
| UNDER FLOOR | An item lists 10%, 20% or 30% or more under floor |
| RARE LISTING | A top 1%, 5% or 10% item lists at most 10% over floor |
| FLOOR MOVE | The floor moves 10%, 20% or 30% or more in 24 hours |
| SWEEP | One wallet buys 5 or 10 items within 10 minutes |
| SOLD | A sale at or above a minimum (any, 0.01, 0.05, 0.1, 0.5 or 1 ETH) |
| MINT REMINDER | 15 minutes before each stage that isn't a Team stage, from the REMINDERS switch or a Remind me tap |

**Routing**

- Muted first: a muted token or collection never sends anything, and a token or collection is watched, muted or neither.
- An All collections alert reaches a chat when the collection passes MAKO's quality checks and the alert is on, or when the chat watches the collection. A watch ignores the switch and the quality checks, and keeps the thresholds.
- A Watched only alert reaches a chat only when it watches the collection, the alert is on and the thresholds hold.
- A user's token watch sends every token alert except NEW TOKEN. A group's token watch does the same, with the group's BONDING marks and BIG BUY/SELL percentage.
- One alert per event per chat, the highest priority first. Paused and topic routes apply to every kind.
- Defaults depend on the chat type: the All collections alerts are on in DMs and off in groups and channels. The Watched only alerts are on everywhere except SOLD.
- At most 3 UNDER FLOOR or RARE LISTING alerts per collection per chat per hour, and one FLOOR MOVE per collection and direction per chat every 6 hours. UNDER FLOOR and RARE LISTING need a floor read within 15 minutes of the listing (ADR 0018).
- Priorities, from first to last: DEV SELL; BONDED, SOLD OUT; BONDING, MINT STARTING, MINT LIVE, MINT REMINDER, RARE LISTING; PUMPING, UPCOMING MINT, MINTED, UNDER FLOOR, SWEEP, BIG SALE, NEW COLLECTION; BIG BUY/SELL, FLOOR MOVE; NEW TOKEN, SOLD.
- A collection that turns real after its mint started gets one MINT STARTING that reads "started Nm ago", with no back-filled marks.
- A user or chat watches up to 50 tokens and 50 collections, counted separately.

**Dedupe:** one alert per token per threshold. PUMPING has a per-token cooldown. A bond alert replaces any pending progress alert for that token. NFT alerts dedupe on the sale or stage they describe.

**Creator sell:** a sell by the launch's creator wallet fires DEV SELL, with realized PnL from the creator's curve trades and the creator's current share of supply.

## Interaction design

Buttons are the main interface, and slash commands open the same screens. Pasting a token or collection address, or an OpenSea link, opens its card.

**Main menu** (`/start`, `/menu`)

| Row | Buttons |
| --- | --- |
| 1 | Add to group or channel |
| 2 | Tokens · NFTs |
| 3 | My alerts · Settings |
| 4 | Help |
| 5 | Community · X |

Tokens and NFTs list the discovery screens: Hot now, Near bonding and Recently bonded for tokens; Minting now, Upcoming and Trending for NFTs. My alerts holds Token alerts, NFT alerts (All collections and Watched only), and the Watched and Muted lists for tokens and NFTs. Settings holds Groups & channels and Delete my data. Help has four pages: Alerts explained, Group setup, Watched & Muted and Privacy.

**Buttons:** an active state is green and reads Watching, Muted or Reminder set; tapping it undoes it. Alert switches are green when on and grey when off. Group buttons never change state: Watch and Remind me open the user's DM.

**Token card buttons:** Trade, Watch, Refresh, Explorer.
**NFT collection card buttons:** the 1h, 24h, 7d and 30d windows, Watch, Recent sales, View.
**Group settings** open in the admin's DM from `/setup`'s Open settings button: Token alerts, NFT alerts, Watched tokens, Watched NFTs, Pause, Remove MAKO.

**Commands**

| Group | Commands |
| --- | --- |
| Lookup | `/t <address>` token card · `/nft <collection> [1h\|24h\|7d\|30d]` collection card · `/nft <collection> <id>` one NFT |
| Watching | `/watch <token address or collection>` · `/alerts` |
| Group admin | `/setup` · `/route` |
| Utility | `/start` · `/menu` · `/help` · `/deletedata` |

In a group `/watch` is for admins and watches for the chat.

**Token card**

1. Header: ticker, name, launchpad, phase (curve or bonded).
2. Rows: market cap, volume and trades, age, and the creator's trades. A bonded token shows when it bonded.
3. Button rows.

When the token has an image, the card is the caption of a square photo. A bonded token's card shows its current market cap, read from the token's Uniswap v4 pool.

**NFT card:** the collection card shows supply, floor, volume and sales for the chosen window, holders, listed count and creator. The NFT card (`/nft <collection> <id>`) adds rank, traits, best offer and best listing from a live OpenSea read, with a cache and a refresh cooldown (ADR 0014).

**Telegram:** messages are HTML with inline keyboards, edited in place as people navigate.

## Data model

The bot owns the `bot` schema in the same Postgres as the indexer. It reads `indexer.events` and `indexer.cursors`, and calls `indexer.opensea_take(int)` and `indexer.opensea_block(int)` with `EXECUTE` only (ADR 0006, ADR 0014).

| Table | Purpose |
| --- | --- |
| `users` | One row per Telegram user: numeric id, settings (JSON), blocked time |
| `chats` | Groups and channels the bot serves: Telegram chat id, kind, owner, settings (JSON), active flag |
| `subscriptions` | A user's watched tokens and muted tokens |
| `chat_token_watches` | The tokens a group or channel watches |
| `nft_watches` | The collections a user or a chat watches, with the user's reminder switch |
| `collection_mutes` | The collections a user or a chat mutes |
| `reminders` | A user's Remind me taps: user and collection |
| `deliveries` | The send queue, the dedupe record and the source for usage metrics |
| `delivery_daily` | Daily delivery counts by alert, chat type and status, rolled up from rows older than 90 days |
| `commands_daily` | Daily command counts |
| `user_actions` | Button and command events with no user column, for product metrics |
| `notices` | Admin notices already sent to a chat, one per reason |
| `token_images` | The Telegram file id of each uploaded token image |
| `state` | Key-value state such as the poller cursor and the NFT alerts start time |

## Reliability

- Every send goes through a queue with per-destination throttles. Telegram allows about 30 messages per second overall and about 20 per minute to one group. A group over budget gets one summary message.
- An alert that waits longer than its window is dropped from the queue and counted in one summary message per chat. The window is 3 minutes, or 30 for DEV SELL, BONDED, UPCOMING MINT, MINTED, SOLD OUT, NEW COLLECTION, FLOOR MOVE, SWEEP, BIG SALE and SOLD.
- Launch floods: when a launchpad has more than 10 launches in 5 minutes, its individual NEW TOKEN alerts stop. Every chat with NEW TOKEN on gets one notice per flood, then one NEW TOKENS card per minute listing that minute's launches, until it slows down. Floods are worked out from the launch events alone, so a restart or replay gives the same result.
- The NFT state is rebuilt from the cursor after a failed pass, so a collection turning real is seen once.
- Group and channel settings are admin-only, with a live admin check on every tap.
- Secrets live in env vars. A secret scanner runs in CI.

## Links and referrals

Outbound trade and marketplace links carry referral codes where the platform offers one (InkyPump).

- Trade buttons open `go.makobot.xyz/t/<address>`, which redirects to the token on its launchpad with `?ref=<code>`. InkyPump tags a visitor who arrives with `?ref=`.
- The Tokens screen links the launchpad through `go.makobot.xyz/inkypump`, which redirects to the launchpad's referral join page.
- NFT buttons (View, Recent sales, the NFT card) open OpenSea through `go.makobot.xyz/n/…`. OpenSea links carry no referral code. The NFTs screen links OpenSea and Chimera through `go.makobot.xyz/p/…`.
- The redirects log a click with no user data. Clicks on the join link have no token and kind `join`.

## Decisions

Dated decision records live in [`adr/`](./adr).
