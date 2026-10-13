# AGENTS.md

## Layout

- `src/rules`: one file per alert. Each turns an indexer event, plus that token's history, into candidate cards. `stats.ts` holds the pure trade math.
- `src/cards`: the platform-neutral `Card` type and money formatting (ADR 0002).
- `src/delivery`: `poller.ts` (events to `bot.deliveries`), `recipients.ts` (who gets what), `sender.ts` (queue drain and throttles), `notices.ts` (admin DMs), `retention.ts`.
- `src/platforms/telegram`: grammY bot, card rendering, sending, error classification.
- `src/menus`: button screens. All settings live in DMs; `/setup` and `/route` run in groups.
- `src/history.ts`: the only SQL that reads the indexer. It may read `indexer.events` and `indexer.cursors` only (the production grants).
- `docs/adr`: dated decision records. Read them before changing behaviour they cover.

## Conventions

- `shortcut:` comments mark deliberate simplifications. Each names its limit and the upgrade path. Search for `shortcut:` before scaling a part of the system.

## Commands

- `pnpm test`: all tests. A throwaway Postgres starts automatically unless `TEST_DATABASE_URL` is set.
- `pnpm lint`, `pnpm typecheck`, `pnpm format`, `pnpm db:migrate`, `pnpm start`.
- Local data: run ink-indexer's `pnpm db:dev` and point `DATABASE_URL` at that database. MAKO adds its `bot` schema next to `indexer`.
- `pnpm tsx --env-file=.env scripts/export-fixture.ts <name> --token <address>` exports real events as a test fixture.

## Adding an alert

1. Add the kind to `AlertKind`, `PRIORITY`, `ALERT_LABEL`, `ALERT_SQUARE`, `ALERT_HELP` and the preset in `src/settings.ts`.
2. Write the rule in `src/rules/<alert>.ts` with tests, and register it in `src/rules/index.ts`.
3. Its settings row, onboarding toggle and routing button come from `ALERTS`, and the button callback patterns in `src/menus/alerts.ts`, `src/menus/start.ts` and `src/menus/chats.ts` are built from `ALERT_PATTERN` in `src/settings.ts`, so they need no edit. Describe its format in the PR.

## Adding a launchpad

1. Add an entry to `LAUNCHPADS` in `src/launchpads.ts`: name, trade URL, referral parameter and env var, preview hosts.
2. The indexer must emit its events with that `launchpad` key. No rendering code changes.
