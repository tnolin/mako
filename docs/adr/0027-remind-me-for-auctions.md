# 0027. Remind me covers auction reminders

Date: 2026-11-19
Status: Accepted

## Context

[ADR 0013](0013-nft-alerts-and-watches.md) says Remind me is for NFT mints only. NFTX auctions have a start and an end that people plan around, and a person who wants to know when an auction is about to end does not always want the collection on their watchlist.

## Decision

- Remind me also queues AUCTION ENDING SOON, 1 hour before an auction ends, for a collection that passes the quality checks and has an auction that has not ended and lasts at least 2 hours. It works without a watch, removes a mute on the collection like it does for mint reminders, and removing the reminder keeps the watch but stops its reminders.
- The tap on an AUCTION LIVE card (or any card of such a collection) answers `Reminder set. I'll message you 1 hour before the auction ends.` For any other collection the answer stays the 15-minute mint copy.
- Watchers get AUCTION ENDING SOON while their REMINDERS switch is on and the watch has reminders on, the same rule as MINT REMINDER. Groups get neither.
- This replaces the sentence "Remind me is for NFT mints only" in ADR 0013.

## Consequences

- One Remind me tap covers both a collection's mint stages and its auction.
- The reminder is a DM only, like MINT REMINDER, and is not sent for an auction shorter than 2 hours.
