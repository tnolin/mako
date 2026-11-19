# 0026. NFTX marketplace and auction alerts

Date: 2026-11-19
Status: Accepted

## Context

NFTX trades NFT collections on Ink through pools, and runs auctions for new ones. Some collections have an OpenSea page and some have only an NFTX market. The indexer's `events-v5` schema carries the NFTX fields: a `market` and `via` on sales, a `floorMarket` and `floorMultiple` on listings and floor moves, `nftxFloorWei`, `poolCount` and `nftxSlug` on stats and launches, and the `nft.auction` event.

## Decision

- **A marketplace label on NFT cards.** A card is labelled NFTX, and its View and Buy buttons open NFTX, when the event it was built from has `market: "nftx"` (or `floorMarket: "nftx"` for a floor move), when it is an auction card or NOW ON NFTX, or when it is a mint alert for a collection that NFTX trades and OpenSea has no page for. Every other card keeps its OpenSea label and links, and so does a card stored before this change.
- **No contract line on NFTX cards.** An NFTX card has no CA or token line and no referral code.
- **Redirects.** `/n/x/<slug>` opens the collection's NFTX page, `/n/xi/<slug>/<token id>` the NFTX page of one item and `/p/nftx` the NFTX home page. The slug is the one on the event, checked against `[a-z0-9-]{1,100}` when the card is built and again by the link server, which never reads the database. A card whose event has no valid slug links `/p/nftx`, and a tap on it is logged from its delivery id. `/p/chimera` keeps redirecting, for screens already sent.
- **The pool side.** A buyer or seller that is the NFTX Locker reads `NFTX pool`. SOLD and BIG SALE on NFTX have a `via` row (`NFTX listing`, `instant sell` or `instant buy`), and RARE LISTING shows its multiple of the floor and, for a Dutch listing, when it ends.
- **SWEEP** leaves out sales to the pool and purchases routed into it, because neither is a buyer's purchase.
- **NOW ON NFTX** is the NEW COLLECTION card for a collection opening on NFTX. It shows the pool's opening price and size and needs the collection to pass the quality checks; an open seen before then is sent when the collection turns `real`, if it is at most a week old. Chimera launches send no alert.
- **Auction cards.** An `nft.auction` event of a collection that passes the quality checks sends UPCOMING AUCTION (switch UPCOMING MINT), AUCTION LIVE (MINT STARTING), MINIMUM BID RAISED (MINTED), AUCTION ENDING SOON (REMINDERS) and AUCTION ENDED (SOLD OUT), the last with a refund variant when the minimum raise was not met. A watch does not skip the quality checks for these. Only auctions in ETH are applied; an auction in another currency gives no card and no reminder.
- **MINIMUM BID RAISED** goes to watchers only, whatever MINTED percentages they chose. It fires when the minimum bid is at least 25% above the last minimum bid that fired (the starting one first) and at least 30 minutes after the last one, and its `(+N%)` is the rise over the starting minimum bid, rounded down. The rule reads the auction's earlier `price` events again on each one, and a fire that sent nothing still counts toward the 30 minutes and becomes the new base.
- **AUCTION ENDING SOON** is queued 60 minutes before an auction that lasts at least 2 hours ends, as a DM to the same audience as MINT REMINDER.
- **Catch-up.** When a collection turns `real` while its auction is upcoming, it gets UPCOMING AUCTION (start at least 10 minutes away) or, while the auction runs, AUCTION LIVE. These use the cards' own dedupe keys and are sent beside the chat's other alert for that snapshot, so a snapshot that turns a collection real can send NOW ON NFTX, an auction card and a mint card to one chat.

## Consequences

- A collection on both marketplaces has OpenSea cards for OpenSea events and NFTX cards for NFTX events.
- The bid-raise rule costs one read of an auction's `price` events per event, and an auction has a handful of them.
- Rows written before the indexer carried the NFTX fields read as before: every new field is optional.
