# Changelog

## Unreleased

### Changed

- The nightly backup now also holds the indexer schema: cursors, collection verdicts, manual marks, OpenSea data and snapshots, and events. The raw chain tables (`nft_mints`, `nft_burns`, `nft_seadrop_mints`, `nft_sales`) are dumped without rows, since a backfill rebuilds them, which keeps the dump near 20 MB. The deploy guide's restore section covers refilling them.

## v0.2.6 (2026-10-27)

### Changed

- Listing alerts (UNDER FLOOR, RARE LISTING) now compare against a floor read within the last 15 minutes, down from 2 hours, so a stale floor no longer triggers or hides an alert.

## v0.2.5 (2026-10-26)

### Fixed

- A collection that turns real while its mint is already running no longer gets a MINT STARTING or MINT LIVE alert unless the stage started within the last hour. Long-running public stages used to alert days after they began.

## v0.2.4 (2026-10-25)

### Added

- Health checks every 5 minutes: they report when the indexer stops writing events, falls behind the chain, the bot falls behind the indexer, or deliveries keep failing, and again when it clears. A day with no alerts sent gets one note with a summary. Reports go to the log and, when set, to Sentry.

### Changed

- A group's settings show the default topic and its routed alerts by topic name, in Token Alerts and NFT Alerts sections. `/route` names the topic it routes to.

## v0.2.3 (2026-10-25)

### Fixed

- NFT alerts keep their image when the artwork is an animated file over 5 MB, such as WIRED. NFT images up to 10 MB are accepted.

## v0.2.2 (2026-10-25)

### Fixed

- MINT STARTING, SOLD OUT and the collection card read the right stage's end time, limit and price when the drop lists its stages in a different order.
- A MINT REMINDER is not sent twice when a drop's stage list changes order.

## v0.2.1 (2026-10-25)

### Fixed

- No MINT STARTING, MINT LIVE, MINTED or SOLD OUT alerts for a collection that finished minting long ago and mints again.

## v0.2.0 (2026-10-25)

MAKO now covers NFTs on Ink. Get alerts for new mints, sell-outs and big sales across every collection, and watch the collections you care about for floor moves, rare listings and sweeps. Groups can watch tokens too.

### Added

- NFT alerts for Ink collections: upcoming mints, mint progress, sell-outs, new collections and big sales, plus under-floor, rare listing, floor move, sweep and sold alerts for watched collections.
- /nft lookups for collections and single NFTs, and pasted collection addresses and OpenSea links.
- Watch, Mute and Remind me buttons on alerts and cards, with the active state in green.
- A new main menu with Tokens, NFTs and My alerts, and separate NFT alert settings for all collections and watched ones.
- Groups can watch tokens and collections with /watch. Group settings open in the admin's DM.

### Changed

- The main menu no longer has a launchpad button.
- New bot profile descriptions.
- Card images load faster and more reliably.

## v0.1.0 (2026-10-17)

- Telegram bot: six alerts, onboarding, menus, token cards, watchlist, group and channel feeds.
- Alert header: the alert name now sits on its own bold line above the ticker.
- Token images are padded to a square, uploaded once per token and reused, on alerts and token cards.
- Supply shares in alerts are bare percentages, such as `60.1M (6.0%)`; `/help` explains them.
- PUMPING leads with how much it pumped.
- Hot now ranks tokens by trades in the last 24 hours, or 7 days when nothing traded, and names the window.
- Near bonding lists unbonded tokens that traded in the last 7 days and are at 10% or more of the curve, highest first.
- Just bonded is now Recently bonded.
- Token cards use the alert layout. Curve tokens show 24h volume and trades; bonded tokens show when they bonded.
- Bonded token cards show the current market cap from the token's Uniswap pool.
- Refresh on a token card works once every 15 seconds per person.
- Two-column main menu. Groups & channels moved into Settings and Community into Help.
- Launch floods: when a launchpad has more than 10 launches in 5 minutes, NEW TOKEN alerts for it are grouped into one message per minute.
