# 0010. Padded alert images, uploaded once per token

Date: 2026-10-13
Status: Accepted

Supersedes ADR 0007.

## Context

ADR 0007 showed token images as a link preview. Telegram sizes the whole message to the preview image, so portrait and small images squeezed the text and the buttons. Telegram gives bots no font sizes, so alert types also read alike in a shared feed.

## Decision

- Token images go out as a photo with the alert as its caption. The bot fetches a 640×640 JPEG that wsrv.nl pads onto the brand background, uploads it with `sendPhoto`, and stores the returned `file_id` per token in `bot.token_images`. Later alerts and token cards for the token send the stored `file_id`.
- The bot never fetches the creator's image URL. It fetches only the wsrv.nl URL, with a 5 second timeout, a `200` status, an `image/*` content type and a 5 MB cap.
- Concurrent first alerts for a token share one fetch and one upload.
- When the fetch fails or Telegram rejects the uploaded image, the token is remembered in memory for one hour and its alerts go as text with the link preview disabled. When Telegram rejects a stored `file_id`, the row is deleted, the alert goes as text, and the next alert uploads again.
- Captions over 1,024 characters go as text. The per-alert image setting stays.
- Token cards (`/t`, pasted addresses, `t_` links, list taps) use the same photo. Refresh edits the caption of a photo card.
- A bold line led by one colour square names the alert type (🟩 new, 🟨 bonding, 🟧 pumping, 🟦 bonded, 🟥 dev sell, 🟪 big), and the bold `$TICKER` follows on its own line.

## Consequences

- wsrv.nl sees a token's image URL once per token, plus again after a failed fetch.
- The first alert for a token costs one extra fetch and upload.
- A `file_id` belongs to one bot token. A new bot starts with an empty cache and fills it as alerts go out.
- Every card has the same width, and alert types are told apart by their square.
