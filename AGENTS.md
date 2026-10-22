# Agent guide

Read `docs/design.md` and `docs/adr/` first. ADRs are inputs, not constraints: if new facts change a decision, write a new ADR that supersedes it.

## Workflow
- Work tracks GitHub issues. One worktree/branch per issue; open a PR with `Closes #N`; the maintainer has delegated merging: squash-merge when CI is green. Never `git stash` (shared refs).
- Software factory: `/factory <issue>` runs spec → build → four reviews → approve or escalate, tracked with issue labels and comments. The skill (`.claude/skills/factory/SKILL.md`) and its `factory-*` agents are repo-agnostic; this repo's commands, reviewer rules and escalation rules are in `.factory/`.
- Architecture changes: add `docs/adr/NNNN-title.md` (copy `0000-template.md`), link it from the PR.
- Deep modules with clear seams: small interfaces, hidden complexity. Prefer boring and minimal.

## Stack and tooling
- TypeScript, pnpm workspaces (`packages/core`, `apps/server`, `apps/web`), Node LTS; Hono, Drizzle, Postgres, Vite + React, zod, vitest, Biome; `just` as task runner (not make); Docker Compose for deployment. See ADR 0007.
- Keep logic that must behave identically on client and server in `packages/core` (no I/O).
- DB: schema in `apps/server/src/schema`; `just migration-generate <name>` then `just migrate` (explicit, not on app start). Never `drizzle-kit push`: it skips the migrations, and the immutability trigger and other hand-written SQL live only there. A new `NOT NULL` column needs a default or a backfill in the same migration (existing rows). Migration `when` values in `meta/_journal.json` must increase with `idx` (a test checks it): after merging a branch with a migration, regenerate yours. Tests need `DATABASE_URL` pointing at a real Postgres: `export $(just db-up)` starts a throwaway one (`just db-up <port> <name>` for parallel checkouts; `just db-down [name]` stops it).
- API: routes use `createRoute` with `summary`, `tags` and error responses (spread `errors`). After any route change run `just openapi` and commit `docs/openapi.json`; otherwise a test fails with "OpenAPI spec changed: run `just openapi` and commit docs/openapi.json". Docs UI is at `/api/docs`, assets self-hosted (no CDN). Guide: `docs/api.md`.
- Secrets: GCP Secret Manager (project `cdsci-infra`) in production, `.env` locally. Never commit or print secrets. Single `DATABASE_URL` (postgresql://).

## Running the app locally for checks
Fresh checkout: `pnpm install --frozen-lockfile`. Pick a free port pair (here 55710 for Postgres, 3710 for the app); parallel checkouts must use different ones.
```sh
export $(just db-up 55710 pf-check-<tag>)   # sets DATABASE_URL
just migrate && pnpm -C apps/web build
cd apps/server && PORT=3710 PUBLIC_BASE_URL=http://localhost:3710 COOKIE_SECURE=false \
  OIDC_CLIENT_ID=dev OIDC_CLIENT_SECRET=dev OIDC_REDIRECT_URI=http://localhost:3710/api/v1/auth/callback pnpm start
just dev-session dev@example.org [--admin]   # prints a session id; owner of group "Dev"
```
- In a browser, set cookie `pf_session=<id>` for `localhost`, path `/api/v1`, then open `http://localhost:3710/app/`. With curl: `-H "cookie: pf_session=<id>"` (unsafe methods also need `-H "origin: http://localhost:3710"`).
- The same `DATABASE_URL` works for `just test`.
- This serves the built web app through the real server, so the participant CSP and cookie rules apply. `just dev` (Vite with hot reload on :5173, proxying to :3000) is for interactive work only.
- Clean up afterwards: stop the server and `just db-down pf-check-<tag>`.

## Invariants (tests must cover these)
- Participant endpoints set no cookies and log no IP/user-agent.
- Group isolation: a user only sees and changes what their group role allows.
- Response data never goes to an LLM or a log. Respondent free text is untrusted input.
- Markdown is the source of truth for surveys; the compiled JSON model is derived; published versions are immutable.

## Commits
- End commit messages with the Co-Authored-By trailer given by the harness.
