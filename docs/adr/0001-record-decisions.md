# 0001. Record decisions as ADRs

- Status: accepted
- Date: 2026-10-14

## Context
Humans and agents both work on this repo and need durable, reviewable reasons for choices.

## Decision
Keep short ADRs in `docs/adr/`. They are inputs, not constraints: a new ADR may supersede an old one when facts change.

## Consequences
Architecture PRs link an ADR. Day-to-day progress lives in issues and PRs, not in docs.
