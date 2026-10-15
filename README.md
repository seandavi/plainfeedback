# plainfeedback

Open-source, self-hostable event-feedback surveys, written in markdown and designed to avoid collecting participant identifiers. Built for the NIH Common Fund Data Ecosystem (CFDE) metrics effort; usable by any consortium that wants to move off one-off Google Forms and Qualtrics.

Live preview: <https://plainfeedback.cancerdatasci.org> (a preview instance; data may be wiped).

"Designed to avoid identifiers" is not a guarantee of anonymity: free text can identify people, small groups can be re-identified, and proxies and CDNs can log IPs outside the app. Read the [threat model](docs/threat-model.md) and the [deploy guide](docs/deploy.md) before collecting real responses.

## Features

- **Roles and groups.** A global admin; per-group owner, creator and viewer. Anything outside your groups is 404. Events belong to groups, surveys to events.
- **Markdown editor.** Split-pane editor with live preview and an insert menu for question blocks; errors carry line numbers. Question types: choice, multi, Likert grid, text, number ([grammar](docs/grammar.md)).
- **Publish versions.** Publishing freezes the draft as an immutable version, and it refuses edits that would change what an existing export column means.
- **Share.** Public link and QR code (SVG or PNG) per survey; close and reopen at any time, optional open/close dates set in the publish dialog (or via the API).
- **Waves.** Tag surveys `pre`, `post`, `followup` or `other`, and give events start and end dates.
- **Participant page.** Keyboard and screen-reader friendly, no cookies, no IP or user-agent logging, a privacy statement per survey, in-memory rate limits.
- **Responses page.** Counts and per-row delete in the staff UI, with a warning that free text can identify people.
- **Export.** CSV (wide) and JSONL for a survey, an event or a group, and the whole deployment for admins. Every row names its event, survey and wave, and each version has a codebook.
- **API.** Per-user API tokens scoped to one group; OpenAPI spec at `/openapi.json`, Swagger UI at `/api/docs` ([API guide](docs/api.md)).
- **Deletion.** Real, cascading deletes for responses, surveys, events and groups. Nothing is deleted on a schedule.

## How it works

You write a survey as markdown. The server compiles it to a JSON survey model (with line-numbered errors). Publishing stores markdown and model as an immutable version; participants answer against that version, and exports are keyed by it. Markdown is the source of truth; the JSON is derived. The compiler and answer validation live in `packages/core` and run identically in the browser and on the server.

Stack: TypeScript, pnpm workspaces, Hono, Drizzle, Postgres, Vite and React. See [`docs/design.md`](docs/design.md).

## Quickstart (local development)

Needs Docker, Node 22+, pnpm and [`just`](https://just.systems).

```sh
pnpm install
cp .env.example .env     # sets DATABASE_URL for the host; add OIDC_* to sign in (docs/deploy-auth.md)
just up db               # Postgres only
just migrate             # apply migrations (explicit; never run on app start)
just dev                 # server on :3000, web on :5173
just lint typecheck test # tests need DATABASE_URL pointing at Postgres
```

## Self-hosting with Docker Compose

```sh
cp .env.example .env     # set PUBLIC_BASE_URL, POSTGRES_PASSWORD, APP_DB_PASSWORD, OIDC_* ...
just up                  # build and start app + Postgres; the app listens on 127.0.0.1:3000
just migrate             # with DATABASE_URL set to the owner role (see deploy guide)
curl localhost:3000/healthz
```

Put a TLS reverse proxy in front with participant-path logging off, sign in, and bootstrap the first admin. The full first-run sequence, proxy configs (Caddy, nginx, Traefik), Cloudflare notes, database roles, backups and retention are in [`docs/deploy.md`](docs/deploy.md); staff sign-in in [`docs/deploy-auth.md`](docs/deploy-auth.md).

## Status and roadmap

Phase 1 (core) is built, deployed on the preview instance and had an independent review ([`docs/reviews/2026-10-14-phase-1.md`](docs/reviews/2026-10-14-phase-1.md)).

- [#13](https://github.com/seandavi/plainfeedback/issues/13) Phase 2: chat-assisted survey authoring (edits the markdown, never sees responses).
- [#14](https://github.com/seandavi/plainfeedback/issues/14) Phase 3: conditionals and multiple pages.
- [#46](https://github.com/seandavi/plainfeedback/issues/46) Small-cell suppression for any aggregate view.
- [#47](https://github.com/seandavi/plainfeedback/issues/47) Automated retention and purge.
- [#98](https://github.com/seandavi/plainfeedback/issues/98) Cross-group read-only token for automated export.
- [#105](https://github.com/seandavi/plainfeedback/issues/105) GA4 on staff pages only, never on participant pages.

Not built: within-person linking across waves (each wave is its own survey), Parquet export, email invitations.

## Documentation

| Doc | What |
|---|---|
| [`docs/design.md`](docs/design.md) | Goals, decisions, phases, data model, API overview |
| [`docs/grammar.md`](docs/grammar.md) | Markdown survey syntax reference |
| [`docs/api.md`](docs/api.md) | API guide with curl examples, exports, tokens |
| [`docs/openapi.json`](docs/openapi.json) | Generated OpenAPI snapshot (`just openapi`) |
| [`docs/deploy.md`](docs/deploy.md) | First run, proxy, logging, DB roles, backups, retention |
| [`docs/deploy-auth.md`](docs/deploy-auth.md) | Staff sign-in (OIDC), admin bootstrap |
| [`docs/threat-model.md`](docs/threat-model.md) | What is and is not protected, residual risks |
| [`docs/privacy-statement-template.md`](docs/privacy-statement-template.md) | Template for a survey's privacy statement |
| [`docs/adr/`](docs/adr/) | Architecture decision records |
| [`docs/reviews/`](docs/reviews/2026-10-14-phase-1.md) | Independent phase-1 review |
| [`research/platform-survey.md`](research/platform-survey.md) | Why build rather than adopt |

## Contributing, security, license

Issues and PRs welcome: [`CONTRIBUTING.md`](CONTRIBUTING.md). Agents: [`AGENTS.md`](AGENTS.md). Report vulnerabilities as described in [`SECURITY.md`](SECURITY.md). MIT licensed.
