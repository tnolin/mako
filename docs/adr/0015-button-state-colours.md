# 0015. Green buttons for active states

Date: 2026-10-23
Status: Accepted

## Context

Watch, Mute and Remind me are toggles, and so are the alert switches and the chosen values in threshold pickers. Text prefixes such as ✓ and · crowd small labels, and ✓ is already the mark for a verified collection. Telegram's Bot API can colour an inline button with the `style` field.

## Decision

- An active button is green (`style: "success"`). Toggles are green when on and grey when off, with no on/off text. Chosen values (the active window, a picker's current value, selected marks) are green with no prefix.
- Watching, Muted and Reminder set are also in the label, so their state doesn't depend on colour.
- Every screen builds these buttons through the helpers in `src/platforms/telegram/ui.ts` (`btnOn`, `toggleBtn`, `stateBtn`, `chosenBtn`). No screen sets `style` itself.
- `BUTTON_COLOURS=0` is the fallback for clients that don't show colour: toggles read `: on` or `: off` and chosen values get a `· ` prefix, for everyone, since the bot can't tell clients apart. The state words need no fallback.
- No client check was made before release. The fallback is the answer if a client shows no colour.

## Consequences

- On a client that ignores `style`, toggles and chosen values look the same on and off until `BUTTON_COLOURS=0` is set.
- One setting changes every screen, with no other change to the screens.
