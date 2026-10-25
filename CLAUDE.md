# CLAUDE.md

Read AGENTS.md first.

- The root holds only README, LICENSE, CONTRIBUTING, CHANGELOG, SECURITY, AGENTS.md, CLAUDE.md and config files. Code lives in `src/`, tests in `test/`, tooling in `scripts/`, docs in `docs/`.
- No scratch folders, generated output, local data or `.env` files in git.
- Write the failing test first. Conventional commits. CI must pass before merge.
- Record significant technical decisions as a new dated ADR in `docs/adr/`.
- Public docs state what the project does, with no comparisons to other projects.
- Never commit secrets. `.env.example` keeps empty values.
- Privacy: the only user identifier stored is the numeric Telegram user id in `bot.users`. Never store or log people's names or usernames, message text, IPs or user agents. Group, channel and topic names aren't personal data and may be stored.
- User-facing text never names a launchpad directly; use `src/launchpads.ts`.
- Mark a deliberate simplification with a `shortcut:` comment that names its limit and the upgrade path, for example `// shortcut: loads every user per batch; filter in SQL past ~50K users`.
