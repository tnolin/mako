# 0014. Live OpenSea item reads

Date: 2026-10-23
Status: Accepted

Amends ADR 0006.

## Context

The NFT card (`/nft <collection> <id>`) shows an item's rarity rank, traits, image, best offer and best listing. The indexer doesn't record these per item, and the Trending list needs OpenSea's own ranking. The indexer already reads OpenSea with one API key and a request budget shared by its jobs.

## Decision

- The bot reads OpenSea API v2 live, for the NFT card and the Trending list, and nowhere else.
- It uses the same key (`OPENSEA_API_KEY`) and spends the indexer's shared budget through two functions, `indexer.opensea_take(int)` and `indexer.opensea_block(int)`. The bot's database role has `EXECUTE` on them and no access to the budget table. A request waits at most 5 seconds for a budget token. A 429 is recorded with `opensea_block`, which pauses every process that shares the key.
- Reads are cached: rank and traits for 7 days (dropped when the collection's rarity calculation time changes), best offer and best listing for 5 minutes, Trending for 10 minutes.
- Refresh on a card works once every 15 seconds per person and card. A tap inside the cooldown answers without touching the database, OpenSea or the budget.
- A request times out after 8 seconds. When OpenSea, the budget or the key is unavailable, the card says some details are unavailable and shows the rest. No key means every live read is unavailable.
- The key is sent only in the `x-api-key` header and is scrubbed from log lines.
- The bot still reads only `indexer.events` and `indexer.cursors` for alerts.

## Consequences

- The card depends on OpenSea being reachable, and on spending part of a budget the indexer also needs.
- A burst of card taps is bounded by the cooldown and the 5 second budget wait, not by OpenSea's limit.
- `grants.sql` must be run again on a server that only has the earlier grants.
