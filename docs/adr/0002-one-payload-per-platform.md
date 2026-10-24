# 0002. One card payload, rendered per platform

Date: 2026-10-02
Status: Accepted

## Context

MAKO sends the same information on every platform it supports, formatted for that platform.

## Decision

Rules and cards produce one platform-neutral payload. `src/platforms/telegram` (grammY, HTML, inline keyboards) renders it.

## Consequences

- A new platform is one adapter.
- Card content is tested once, rendering per platform.
