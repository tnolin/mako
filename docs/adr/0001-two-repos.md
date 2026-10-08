# 0001. Two public repos: ink-indexer and mako

Date: 2026-10-02
Status: Accepted

## Context

The SDK and indexer are useful without the bot, and the bot is one consumer of them.

## Decision

Keep `ink-indexer` and `mako` as separate repos with their own licenses, issues and releases. During development the bot links the local SDK and events packages with pnpm; in production it installs them from npm.

## Consequences

- Each repo has a clear audience.
- Changes to the event schema are versioned releases the bot upgrades to.
