# Changelog

## Unreleased

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
