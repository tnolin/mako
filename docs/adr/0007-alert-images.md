# 0007. Alert images: large link preview, sendPhoto fallback

Date: 2026-10-12
Status: Superseded by 0010

## Context

Alerts show the token's image. Tested live in Telegram on 2026-10-12: with `prefer_small_media`, direct jpg and png links (about 95% of token images) render an empty preview box. webp and gif previews worked. Without `prefer_small_media`, jpg previews render large. `sendPhoto` worked for jpg, webp, gif and jfif, and failed for one IPFS gateway.

## Decision

- Launchpad image hosts: `sendMessage` with `link_preview_options: { url, show_above_text: true }`.
- Other hosts: `sendPhoto` with the alert as caption; on a media error, the alert goes as text.
- Images are on by default for every alert and can be turned off per alert type.

## Consequences

- Alerts are taller than a small thumbnail would be. A per-token page with the token image as `og:image` is the follow-up for small thumbnails.
