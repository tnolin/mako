# 0016. Image padding in the bot

Date: 2026-10-24
Status: Accepted

Amends ADR 0010.

## Context

ADR 0010 padded every card and alert image through wsrv.nl. A first image often took 2 to 3 seconds there, and sometimes more than the 5 second limit. A timed-out image was then remembered as failed for an hour, so the card went out as text every time, and time-critical alerts can go stale in the queue while they wait.

## Decision

- The bot fetches the creator's image itself and pads it in process with sharp: a 640×640 JPEG with the image fitted on the brand background (#1a2236), as before.
- Creator URLs are untrusted, so a fetch is allowed only for `https` URLs whose host resolves to public addresses: no loopback, private, link-local, unique-local, shared, multicast or unspecified address. Redirects are followed by hand, at most 3, and each target is checked the same way. The 5 MB cap stays. Decoding stops above 40 million pixels, and only the first frame of an animation is used.
- A send waits up to 3 seconds for a first image and otherwise goes as text. The fetch goes on for up to 15 seconds, and an image that arrives late is kept in memory for the next send, which uploads it and stores the `file_id`. Only a real failure (bad status, not an image, too large, blocked address, undecodable) is remembered for an hour.
- The `file_id` cache in `bot.token_images` is unchanged.

## Consequences

- No outside service sees image URLs or sits in the path of an alert. Image hosts see the server's address instead.
- The bot depends on sharp's prebuilt native binaries.
- The host is resolved once for the check and again when fetch connects, so a host that changes its answer in between could reach an internal address. Pinning the checked address in a custom dispatcher would close that.
- Late images are kept in memory only (at most 100); a restart loses them and the next send fetches again.
