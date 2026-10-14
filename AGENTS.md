# Agent guide

Read `docs/design.md` and `docs/adr/` first. ADRs are inputs, not constraints: if new facts change a decision, write a new ADR that supersedes it.

## Workflow
- Work tracks GitHub issues. One worktree/branch per issue; open a PR with `Closes #N`; merge on green CI. Never `git stash` (shared refs).
- Architecture changes: add `docs/adr/NNNN-title.md` (copy `0000-template.md`), link it from the PR.
- Deep modules with clear seams: small interfaces, hidden complexity. Prefer boring and minimal.

## Stack and tooling
- Python via `uv`; FastAPI; Postgres; `ruff` (loose) and a type checker; `just` as task runner (not make); Docker Compose for deployment.
- Secrets: GCP Secret Manager (project `cdsci-infra`) in production, `.env` locally. Never commit or print secrets. Use a single `postgresql://` URI env var.

## Invariants (tests must cover these)
- Participant endpoints set no cookies and log no IP/user-agent.
- Group isolation: a user only sees and changes what their group role allows.
- Response data never goes to an LLM or a log. Respondent free text is untrusted input.
- Markdown is the source of truth for surveys; the compiled JSON model is derived; published versions are immutable.

## Commits
- End commit messages with the Co-Authored-By trailer given by the harness.
