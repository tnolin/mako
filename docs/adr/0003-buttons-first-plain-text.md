# 0003. Buttons first, plain-text alerts

Date: 2026-10-02
Status: Accepted

## Context

Traders act fast and many never type commands. Image cards are slower to generate and send.

## Decision

Every card and menu ends in buttons; slash commands open the same screens. Alerts are plain text (Telegram HTML, Discord embeds).

## Consequences

- Fast delivery and low cost per alert.
- Generated image cards can be added later behind the same payload.
