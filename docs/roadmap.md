# Roadmap

Later phases may change based on how people use v0.

## v0: Telegram launch

- Button-driven onboarding with alert presets
- Curve progress, velocity and bond / graduation alerts across Ink launchpads
- Creator sell alerts
- New launch, big buy / sell, market cap target and price move alerts
- Universal address lookup (paste an address or `/t`)
- Personal watchlist
- NFT sales, cheap listing and floor move alerts for Ink collections
- Lending health factor and liquidation alerts
- Group feeds with per-group filters, quiet hours and hourly caps
- Official MAKO alert channels on Telegram and Discord

## v1

- Discord parity
- Deployer history (`/dev`) and serial deployer alerts
- Stock-paired launch filter (xStocks pairs)
- Launchpad leaderboard alerts (King of the INK, Emperor of the INK)
- NFT rarity ranks, trait lookup and rare listing alerts
- Holder stats, top holder exits, whale buys, volume spikes
- Wallet follow alerts

## v2

- Wallet verification and holder role gating
- Web hub: live feed, leaderboards, charts
- Group call tracking and ATH leaderboards
- Natural-language alert setup
- Daily Ink recap posts
- Trade buttons and quick buy through partner bots that support Ink

## Build order

1. ink-indexer: InkyPump V2 events into Postgres, normalized `events` table, backfill and reconnect
2. Telegram bot: `/t` lookup, curve progress and bond alerts in one test group
3. Tsunami and Calamari
4. OpenSea sales and listings, Tydro health alerts
5. Group `/setup`, throttling queue, heartbeat; private beta in a few groups
6. Public Telegram launch and docs site
7. Discord parity
8. v1 features
9. SDK and MCP server on npm; hosted API private beta
