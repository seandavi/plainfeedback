# Agent guide

Read `docs/design.md` and `docs/adr/` first. ADRs are inputs, not constraints: if new facts change a decision, write a new ADR that supersedes it.

## Workflow
- Work tracks GitHub issues. One worktree/branch per issue; open a PR with `Closes #N`; the maintainer has delegated merging: squash-merge when CI is green. Never `git stash` (shared refs).
- Architecture changes: add `docs/adr/NNNN-title.md` (copy `0000-template.md`), link it from the PR.
- Deep modules with clear seams: small interfaces, hidden complexity. Prefer boring and minimal.

## Stack and tooling
- TypeScript, pnpm workspaces (`packages/core`, `apps/server`, `apps/web`), Node LTS; Hono, Drizzle, Postgres, Vite + React, zod, vitest, Biome; `just` as task runner (not make); Docker Compose for deployment. See ADR 0007.
- Keep logic that must behave identically on client and server in `packages/core` (no I/O).
- DB: schema in `apps/server/src/schema`; `just migration-generate <name>` then `just migrate` (explicit, not on app start). Never `drizzle-kit push`: it skips the migrations, and the immutability trigger and other hand-written SQL live only there. A new `NOT NULL` column needs a default or a backfill in the same migration (existing rows). Migration `when` values in `meta/_journal.json` must increase with `idx` (a test checks it): after merging a branch with a migration, regenerate yours. Tests need a real Postgres: `pnpm install && just db-up && just test` works from a fresh clone with no `.env` (`just test` defaults `DATABASE_URL` to the `db-up` database; `DB_PORT=...` if 5432 is taken).
- API: routes use `createRoute` with `summary`, `tags` and error responses (spread `errors`). After any route change run `just openapi` and commit `docs/openapi.json`; otherwise a test fails with "OpenAPI spec changed: run `just openapi` and commit docs/openapi.json". Docs UI is at `/api/docs`, assets self-hosted (no CDN). Guide: `docs/api.md`.
- Secrets: GCP Secret Manager (project `cdsci-infra`) in production, `.env` locally. Never commit or print secrets. Single `DATABASE_URL` (postgresql://).

## Invariants (tests must cover these)
- Participant endpoints set no cookies and log no IP/user-agent.
- Group isolation: a user only sees and changes what their group role allows.
- Response data never goes to an LLM or a log. Respondent free text is untrusted input.
- Markdown is the source of truth for surveys; the compiled JSON model is derived; published versions are immutable.

## Commits
- End commit messages with the Co-Authored-By trailer given by the harness.
