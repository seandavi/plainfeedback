# plainfeedback

Open-source, self-hostable, de-identified event-feedback surveys, built for the
NIH Common Fund Data Ecosystem (CFDE) metrics effort and usable by any
consortium that wants to move off one-off Google Forms and Qualtrics.

- Surveys are written in **markdown** (with a live-preview editor) and shared as a link or QR code.
- Designed to avoid collecting participant identifiers: the app sets no cookies and logs no IP or user-agent. See the limits in [`docs/design.md`](docs/design.md#privacy).
- Groups with owners, creators and viewers; an admin manages the system.
- Free-text answers and CSV/JSONL/Parquet export for analysis.

**Status:** design stage. See [`docs/design.md`](docs/design.md), the decision
records in [`docs/adr/`](docs/adr/), and the platform comparison in
[`research/platform-survey.md`](research/platform-survey.md).

## Quickstart

Needs Docker, plus Node 22 + pnpm and [`just`](https://just.systems) for development.

```sh
just up                      # build and start app + Postgres (docker compose)
curl localhost:3000/healthz  # {"status":"ok"}
just down

cp .env.example .env         # local dev: just up db, then
pnpm install && just dev     # server on :3000, web on :5173
just lint typecheck test
```

The compose default DB password is for local dev only; set `POSTGRES_PASSWORD` for anything else.

## Contributing

Issues and PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md). Agents:
see [`AGENTS.md`](AGENTS.md). Security issues: [`SECURITY.md`](SECURITY.md).

MIT licensed.
