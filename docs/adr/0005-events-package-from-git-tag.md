# 0005. Event types from an ink-indexer git tag until npm

Date: 2026-10-12
Status: Accepted

Amends ADR 0001 for now.

## Context

ADR 0001 says the bot installs the SDK and event packages from npm in production. ink-indexer publishes to npm later. MAKO needs the event types now, and only the types, because it reads the events table directly.

## Decision

- Install `@ink-indexer/events` as a pnpm git dependency, pinned to a tag: `github:tnolin/ink-indexer#events-v1&path:/packages/events`.
- The package exports TypeScript source, so MAKO runs under tsx in production, like the indexer.
- A schema change lands in ink-indexer with a new tag (`events-v2`), and MAKO bumps the tag in a PR.
- Switch to the npm package once it is published.

## Consequences

- CI and the server install the same pinned tag with no registry.
- Plain `node` cannot load the package; `tsx` is required.
