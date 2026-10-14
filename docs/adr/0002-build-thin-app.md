# 0002. Build a thin app instead of adopting a platform

- Status: accepted
- Date: 2026-10-14

## Context
No surveyed tool combined self-hosting, group-owner RBAC, anonymous links and a Python stack. See `research/platform-survey.md`.

## Decision
Build FastAPI + Postgres with a small custom renderer. SurveyJS Form Library (MIT) is the fallback renderer; Survey Creator (paid) is not used. REDCap and LimeSurvey remain fallbacks.

## Consequences
We own security, privacy and maintenance. Scope stays small to keep that tractable.
