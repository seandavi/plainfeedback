# 0004. v1 uses a shared anonymous link; no participant tokens

- Status: accepted
- Date: 2026-10-14

## Context
Per-person tokens and email add identity-handling and distribution complexity. Surveyors can share a link or QR code directly.

## Decision
Each published survey has a public link and QR code. Responses carry no participant identifier. Pre/post linking via hashed tokens, and email, are deferred until a use case needs participant identity.

## Consequences
Waves are separate surveys analysed in aggregate; within-person pre/post is not possible in v1 (retrospective pre/post items still work). Responses may be duplicated by one person; accepted.
