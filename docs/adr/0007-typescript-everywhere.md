# 0007. TypeScript across server, shared core and web

- Status: accepted
- Date: 2026-10-14

## Context
The markdown compiler, the question model and (phase 3) the conditional-expression evaluator must behave identically in the editor preview, the participant page and the server. Two implementations (Python server, JS browser) would drift. ADR 0002 assumed Python/FastAPI; the maintainer is fine with TypeScript for the whole stack.

## Decision
Use TypeScript end to end, as a pnpm monorepo on Node (LTS):
- `packages/core`: markdown grammar, compiler, JSON model schemas (zod), expression evaluator, answer validation. No I/O. Runs in browser and server.
- `apps/server`: Hono (HTTP), Drizzle ORM + Postgres, OIDC auth, OpenAPI from zod schemas.
- `apps/web`: Vite + React SPA for the editor and participant page (CodeMirror 6 for editing). No third-party requests at runtime.
- Tooling: vitest, Biome, `just` as the task runner, Docker Compose for deployment.

This supersedes the Python/FastAPI/uv choices in ADR 0002 and the earlier frontend plan. Everything else in 0002 stands.

## Consequences
- The server can validate answers with the exact code the browser used (closes the phase-3 "second evaluator" gap).
- Python consumers use the export API; no Python runtime is required to self-host.
- Contributors need Node/pnpm instead of uv.
