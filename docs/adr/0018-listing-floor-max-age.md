# 0018. Listing floor max age

Date: 2026-10-27
Status: Accepted

## Context

UNDER FLOOR and RARE LISTING compare a listing's price with the collection floor carried on the listing event. The bot dropped a listing only when that floor was more than 2 hours older than the listing, so an alert could compare a price against a floor that had since moved. A floor that had risen made an ordinary listing look like a discount. A floor that had fallen hid a real one.

The indexer now reads a fresh floor for a listing when the stored one is more than 10 minutes old, so listing events normally carry a floor read within the last 10 minutes.

## Decision

- `FLOOR_MAX_AGE_S` is 15 minutes (900 seconds), down from 2 hours. A listing whose floor was read more than 15 minutes before the listing's block time produces no UNDER FLOOR or RARE LISTING candidate.
- The limit sits 5 minutes above the indexer's 10-minute refresh, so a floor refreshed on schedule always passes.
- A listing with no floor is still skipped.

## Consequences

- Alerts compare against a floor that is at most 15 minutes old.
- When the indexer cannot refresh a floor, for example while a marketplace read fails, listings for that collection produce no alerts until it can, rather than alerting against an old floor.
- The limit is only applied to listing alerts. FLOOR UP and FLOOR DOWN use the collection stats, not a listing's floor, and are unchanged.
