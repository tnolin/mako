# 0002. One card payload, rendered per platform

Date: 2026-10-02
Status: Accepted

## Context

MAKO launches on Telegram and follows with Discord. Both need the same information with different formatting.

## Decision

Rules and cards produce one platform-neutral payload. `src/platforms/telegram` (grammY, HTML, inline keyboards) and `src/platforms/discord` (discord.js, embeds, buttons) render it.

## Consequences

- Discord parity is one adapter.
- Card content is tested once, rendering per platform.
