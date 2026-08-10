# Contributing

## Before you start

Read `CLAUDE.md`. It contains the working rules for this repository — dependency direction,
error handling, tenancy scoping, and what not to do. They are enforced in CI, so reading them
first saves you a round trip.

For anything larger than a bug fix, open an issue describing the problem before writing code.
A rejected pull request wastes more of your time than a five-minute discussion.

## Setup

```bash
corepack enable
pnpm install
docker compose up -d
pnpm verify
```

## The rules that matter most

- **No `any`, no `@ts-ignore`.** Strict mode stays on.
- **No bare `catch`.** Every error belongs to the taxonomy in `packages/contracts`.
- **Every tenant query filters `org_id`.** Row-level security is defence in depth, not the control.
- **Never trust a client-supplied user id.**
- **Default-deny** for anything the agent can call.
- **Every external call has a timeout.**
- **No stubs presented as working.** If it is not implemented, leave it out and say so.

## Pull requests

- One coherent change. Do not reformat files your change did not touch.
- Tests included, with at least one failure-path test.
- New dependency? Justify it in the description, including what you considered instead.
- Touching identity, authorization, tool execution, secrets or egress? Name the affected
  entries in `docs/security/threat-model.md`.
- Run `pnpm verify` before pushing.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). Add a changeset
(`pnpm changeset`) for anything that changes published package behaviour.

## Design changes

If your change contradicts something in `docs/architecture/`, update the document in the same
pull request. Code and design drifting apart is how a codebase becomes unmaintainable.
