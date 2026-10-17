# plainfeedback: code review conventions

- Shared client and server logic lives in `packages/core`, with no I/O.
- Routes use `createRoute` with errors, and `docs/openapi.json` is regenerated.
- Migrations came from `just migration-generate`, and the journal order holds. No `drizzle-kit push`.
- The docs it touches are updated: `docs/api.md`, `docs/grammar.md`, `docs/design.md`.
