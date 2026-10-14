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

## Dev quickstart

Requires [uv](https://docs.astral.sh/uv/) and [just](https://github.com/casey/just).

```sh
cp .env.example .env   # local settings, no secrets
uv sync
just dev               # http://localhost:8000/healthz
just test              # pytest
just lint              # ruff
just typecheck         # pyright
just up                # app + Postgres via Docker Compose (just down to stop)
```

## Contributing

Issues and PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md). Agents:
see [`AGENTS.md`](AGENTS.md). Security issues: [`SECURITY.md`](SECURITY.md).

MIT licensed.
