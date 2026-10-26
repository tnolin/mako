# 0013. NFT alerts, watches and mutes

Date: 2026-10-23
Status: Accepted

Amended 2026-10-26: the catch-up rule applies only to a stage that started within the last hour, so a collection that turns real during a long-running mint gets no MINT STARTING or MINT LIVE for it. A stage start still alerts live, and the UPCOMING MINT catch-up is unchanged.

## Context

The indexer's `events-v2` schema adds NFT events: collections, launches, drops, mints, listings, sales and stats. Mint alerts are useful to everyone in a feed. Market alerts (listings, floor moves, sweeps) are only useful for collections a person watches, and would flood a feed if sent for every collection. Groups and channels need the same choice as DMs.

## Decision

- **Two groups of alerts.** All collections: UPCOMING MINT, MINT STARTING, MINT LIVE, MINTED, SOLD OUT, NEW COLLECTION and BIG SALE. Watched only: UNDER FLOOR, RARE LISTING, FLOOR MOVE, SWEEP, SOLD and the mint reminders. Each group has its own settings screen.
- **A collection is in the feed when it passes MAKO's quality checks** (the indexer's `real` verdict). An All collections alert reaches a chat when the collection is in the feed and the alert is on, or when the chat watches the collection; a watch ignores the switch and the verdict but keeps the thresholds. A Watched only alert needs the watch, the switch and the thresholds.
- **Defaults depend on the chat type, not on whether the settings are new.** In DMs the All collections alerts are on. In groups and channels they are off. The Watched only alerts are on everywhere except SOLD, which is off with a 0.05 ETH minimum.
- **One verb, Watch,** for tokens and collections. An item is watched, muted or neither: Mute also stops watching, and Watch on a muted item removes the mute. Remind me is for NFT mints only. It sends a message 15 minutes before each stage that isn't a Team stage, removes a mute on the collection, and works without a watch. Removing a reminder keeps the watch but stops its reminders.
- **Groups watch too.** An admin's `/watch` in a group takes a token or a collection for the chat, up to 50 tokens and 50 collections, counted separately. A group's token watch sends every token alert for that token except NEW TOKEN, whatever the group's switches say, with the group's BONDING marks and BIG BUY/SELL percentage. Topic routes and paused routes apply as for the feed. The Watch button on a group alert opens the user's DM and never changes the group.
- **Group settings open in the admin's DM,** never in the group. The group's settings screen links to its alert screens and its Watched tokens and Watched NFTs lists, and checks admin rights live on every tap.
- **Storage.** Token watches of a chat are in `bot.chat_token_watches`. Collection watches and mutes are in `bot.nft_watches` and `bot.collection_mutes`, for a user or a chat. None has a foreign key on the chat id, because chat rows are soft-removed. A group that becomes a supergroup carries all of them to its new chat id.
- **Limits.** At most 3 UNDER FLOOR or RARE LISTING alerts per collection per chat per hour. One FLOOR MOVE per collection and direction per chat every 6 hours. UNDER FLOOR needs a floor read from the last 2 hours. One alert per event per chat, the highest priority first.
- **Catch-up rule.** When a collection turns real after its mint started, the chat gets one MINT STARTING that reads "started Nm ago", with no back-filled marks and no duplicate when the stage's own event is processed later. The catch-up is sent only when that stage started at most an hour ago (`CATCH_UP_MAX_S`), so a public stage that has been open for days does not alert when the collection turns real.
- **Backfilled history never alerts.** NFT events older than the alerts start time update the in-memory collection state but skip the rules.

## Consequences

- A watcher can get alerts for a collection that fails the checks, which is what watching means.
- The in-memory collection state is rebuilt from the cursor at start and after a failed pass, so memory and start-up time grow with the number of collections.
- Group settings need a DM with the bot, so an admin who has never started it is asked to.
- The caps and cooldowns drop some alerts quietly.
