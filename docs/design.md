# plainfeedback: design

De-identified event-feedback surveys for the Common Fund Data Ecosystem (CFDE) metrics grant. Open source, MIT licensed. Decisions are recorded in [`adr/`](adr/0001-record-decisions.md). Platform survey and rationale: [`research/platform-survey.md`](https://github.com/seandavi/plainfeedback/blob/main/research/platform-survey.md).

## Goals

- Pre / post / long-term follow-up surveys per event (separate surveys per wave in v1; within-person linking later, without PII).
- Free-text answers for loose qualitative research; export for analysis and the metrics pipeline.
- No cookies; no IP or user-agent logging; privacy statement per survey.
- Roles: global admin; per-group owner, creator, viewer; anonymous participants.
- Replace the per-group bespoke Google Forms / Qualtrics.

## Decisions so far

| Topic | Decision |
|---|---|
| Build vs adopt | Build a thin app. No platform met self-host, group-owner RBAC, token-linked waves and a Python stack (see research). REDCap and LimeSurvey remain fallbacks. |
| Stack | TypeScript end to end, pnpm monorepo: shared `core`, Hono + Drizzle + Postgres server, Vite + React web ([ADR 0007](adr/0007-typescript-everywhere.md)). |
| Authoring | Markdown is the source of truth. It compiles to a JSON survey model; the JSON is what is stored, rendered, validated and exported. |
| Renderer | Small custom React renderer in the web app, driven by the compiled JSON model. SurveyJS is not used. |
| Auth | Pluggable OIDC. Google is the first provider. For the CDSCI deployment the client id and secret are in GCP Secret Manager (`cdsci-infra`: `cancerdatasci-oauth-client-id`, `cancerdatasci-oauth-client-secret`). |
| Participants | v1: shared anonymous link and QR code, no tokens, no email ([ADR 0004](adr/0004-anonymous-link-only-v1.md)). Built: `/s/{publicId}` page, one single-use ticket per response and in-memory rate limits ([ADR 0011](adr/0011-participant-page.md), [0013](adr/0013-transient-client-rate-limit.md), [0014](adr/0014-single-use-tickets-and-crowd-sized-limit.md)). |
| Permissions | Group roles owner, creator, viewer plus a global admin; anything outside your groups is 404 ([ADR 0009](adr/0009-group-rbac-404.md)). Per-user API tokens scoped to one group, never above the owner's rights ([ADR 0010](adr/0010-api-tokens.md)). |
| Time and deletion | Submission time is stored to the hour. Deletion is real and cascades; nothing deletes on a schedule ([ADR 0012](adr/0012-deletion-and-coarse-time.md)). |
| Export | JSONL (lossless) and wide CSV, streamed, for a survey, an event, a group (and the whole deployment for admins). Every row names its event, survey and wave, and publishing refuses changes that would change what an existing column means ([ADR 0015](adr/0015-export-column-stability.md)). Parquet is deferred. |
| Deployment | Docker Compose ([ADR 0006](adr/0006-docker-compose.md)). Phase 1 is deployed as a preview instance on onclappc02 (`https://plainfeedback.cancerdatasci.org`, Traefik + Cloudflare; data may be wiped), using `deploy/onclappc02/compose.override.yaml`. The app image holds production dependencies only; it connects to Postgres as a role without `ALTER`, `TRUNCATE` or `UPDATE` on responses and versions ([deploy guide](deploy.md#database-roles)). |
| Chat layer | Edits the markdown, never the JSON. Phase 2, not started ([#13](https://github.com/seandavi/plainfeedback/issues/13)). |
| Conditionals, pages | Phase 3, not started ([#14](https://github.com/seandavi/plainfeedback/issues/14)). The JSON model has the slots from phase 1 (`pages[]`, reserved `visibleIf`). |

## Phases

1. **Core** (done and deployed; the [phase-1 review](reviews/2026-10-14-phase-1.md) was independent and its findings were filed and fixed as issues; privacy follow-ups still open: [#46](https://github.com/seandavi/plainfeedback/issues/46) small-cell suppression, [#47](https://github.com/seandavi/plainfeedback/issues/47) automated retention; also [#98](https://github.com/seandavi/plainfeedback/issues/98) cross-group export token and [#105](https://github.com/seandavi/plainfeedback/issues/105) GA4 on staff pages only): groups and roles, API and API tokens, markdown to JSON, single-page renderer, web markdown editor with live preview, publish with shareable link and QR code, response viewer, export, deletion, staff UI for groups, events and surveys.
2. **Chat** (not started, [#13](https://github.com/seandavi/plainfeedback/issues/13)): markdown-editing assistant with live preview, blank-page start with suggested prompts, intake from pasted text or uploaded documents.
3. **Conditionals and multiple pages** (not started, [#14](https://github.com/seandavi/plainfeedback/issues/14)): grammar and renderer extensions; update the chat's grammar spec and examples.

## Data model

- `users` (`is_admin`, `disabled_at`), `sessions` (hash of the cookie only), `groups` (`archived_at`), `memberships(group, user, role: owner|creator|viewer)`, `pending_invites(group, email, role)` (become memberships at verified sign-in, [ADR 0016](adr/0016-pending-invites.md))
- `events` (belongs to a group, slug unique per group, title, description, optional `starts_on` / `ends_on` calendar dates, CHECK end >= start)
- `surveys` (belongs to an event; slug; random `public_id` for the participant link; nullable wave label, CHECK in `pre|post|followup|other`, with a partial unique index so an event has at most one pre, one post and one followup (`other` may repeat; null = not a wave, e.g. speaker feedback); current draft markdown and ETag; `closed_at`)
- `survey_versions` (immutable; markdown, compiled JSON model, privacy statement, open/close dates; a trigger rejects UPDATE, TRUNCATE and ad-hoc DELETE)
- `responses` (survey_version, answers JSONB, `submitted_at` to the hour (CHECK), `seq` global identity for export order; no identifier column)
- `api_tokens` (user, group, role, hash, expiry, `revoked_at`, `last_used_at`)
- participant tokens for within-person linking are deferred and have no table

## Survey JSON model

`pages[] -> questions[]`. Each question has a stable author-set slug `id`, `type` (choice, multi, likert, text, number, date), `required`, options or statements, and an optional `visibleIf` (unused until phase 3). Likert scale anchors are stored in the version so exports stay interpretable. Answers are keyed by question id.

## Markdown grammar (overview)

The full reference is [`grammar.md`](grammar.md); this is the flavour.

Pandoc-style fenced divs, as in `quarto-revealjs-live-questions`. Worked example, from the CFDE Fall 2026 meeting feedback form:

```markdown
# 2026 Fall Meeting Feedback

We want to hear your feedback. Your answers are anonymous. Agenda: [here](https://example.org).

::: {.choice #affiliation required other="Other"}
What is your main CFDE affiliation?
- CFDE Center Member
- CFDE DCC Member
- NIH Representative
:::

::: {.likert #ratings scale="1-5" low="Not at all / Poor" mid="Somewhat / Okay" high="Very / Excellent"}
Answer any applicable questions:
- Before attending, how familiar were you with the CFDE?
- After attending, how familiar do you feel with the CFDE?
- Overall, how satisfied are you?
:::

::: {.text #elaborate maxlength=2000}
Please elaborate on your answers above.
:::
```

The Likert grid is first-class (the real form has 13 statements on one shared scale).

## Pre/post linking (deferred)

v1 has no participant identifiers: a published survey has one public link and QR code, and each wave is its own survey. Retrospective pre/post items (as in the CFDE form) work. Deferred design, if within-person linking is wanted later: each event gets a batch of random codes, distributed as links or QR codes. The same code works for all waves of the event; the database keeps only its hash. Without a code, a response is anonymous and unlinked. Lost codes cannot be recovered. Whether to offer a separately stored "remind me" email for follow-ups is **open**.

## Privacy

Goal: avoid collecting participant identifiers. This is not a guarantee of anonymity. Limits: free text can contain identifying details; small groups can be re-identified from demographic fields; reverse proxies, hosting providers and networks may log IPs outside the app, so deployers must configure their own stack; a shared link allows duplicate submissions.

- No cookies. Page state lives in memory; `sessionStorage` use must be stated in the privacy statement.
- No IP or user-agent logging, including in reverse-proxy logs for participant endpoints.
- Free text can contain identifying details; viewers see a warning, and small groups can be re-identified from demographic fields. Any aggregate view must suppress cells with fewer than 5 responses (configurable), including cells recoverable from totals ([#46](https://github.com/seandavi/plainfeedback/issues/46)).
- Submission time is stored to the hour only ([#37](https://github.com/seandavi/plainfeedback/issues/37)).
- Deletion is real (no soft delete) and cascades; backups keep data until they rotate. Retention is the owner's and operator's job; nothing deletes on a schedule ([#36](https://github.com/seandavi/plainfeedback/issues/36), [#47](https://github.com/seandavi/plainfeedback/issues/47), [ADR 0012](adr/0012-deletion-and-coarse-time.md)).
- Chat and intake only see survey drafts and source documents, never responses. Respondent free text is untrusted input.
- Open: participant withdrawal by code; model provider disclosure for phase 2.

## API (`/api/v1`)

Staff authenticate with OIDC sessions or per-user API tokens scoped to a group and role (never above the owner's rights).

```
POST   /groups                                  admin
GET    /groups                                  admin: all; others: their groups
GET    /groups/{g}                              viewer
PATCH  /groups/{g}                              owner: rename, archive
DELETE /groups/{g}                              admin: only once archived; cascades
GET    /groups/{g}/members                      viewer
PUT    /groups/{g}/members/{user}               owner: {user} is an id or an email; unknown email = invite (202)
DELETE /groups/{g}/members/{user}               owner (never the last owner)
GET    /groups/{g}/invites                      viewer: pending invites
DELETE /groups/{g}/invites/{email}              owner: revoke an invite
GET    /users                                   admin
PATCH  /users/{id}                              admin: grant/revoke admin (never the last admin)
GET    /groups/{g}/events                       viewer
GET    /groups/{g}/events/{e}                   viewer ({e} is the event slug here)
PUT    /groups/{g}/events/{e}                   creator: upsert by slug {title, description, startsOn?, endsOn?}; returns the event id
DELETE /groups/{g}/events/{e}                   owner: cascades to surveys and responses
GET    /events/{e}/surveys                      viewer ({e} is the event id)
GET    /events/{e}/surveys/{s}                  viewer: draft markdown, ETag, latest version summary
PUT    /events/{e}/surveys/{s}                  creator: upsert draft (text/markdown or JSON); If-Match to update
PATCH  /events/{e}/surveys/{s}                  creator: {closed?, waveLabel?} stops or resumes accepting responses, sets the wave
DELETE /events/{e}/surveys/{s}                  owner; creator if never published. Cascades
POST   /events/{e}/surveys/{s}/validate         viewer: dry run of supplied or stored markdown, no writes
POST   /events/{e}/surveys/{s}/publish          creator: freeze the draft as a new version
GET    /events/{e}/surveys/{s}/versions         viewer
GET    /events/{e}/surveys/{s}/versions/{n}     viewer
GET    /events/{e}/surveys/{s}/link             viewer: public URL + published flag
GET    /events/{e}/surveys/{s}/link/qr.svg|png  viewer: QR code of that URL (png: ?size=)
GET    /events/{e}/surveys/{s}/responses?format=jsonl|csv&since=<seq|ISO>&version=   viewer
GET    /events/{e}/responses                    viewer: every survey of the event (same query, no version)
GET    /groups/{g}/responses                    viewer: every survey of the group
GET    /responses                               admin, session only: the whole deployment, JSONL
GET    /events/{e}/surveys/{s}/versions/{n}/codebook   viewer: questions and CSV columns of that version
DELETE /events/{e}/surveys/{s}/responses?before=  owner: returns the count
DELETE /events/{e}/surveys/{s}/responses/{id}     owner

POST   /groups/{g}/tokens                       any member, session only: create an API token for yourself (secret shown once)
GET    /groups/{g}/tokens                       session only: owners see all of the group's, others their own
DELETE /groups/{g}/tokens/{id}                  session only: owners revoke any, others their own
GET    /me/tokens                               your tokens
GET    /me                                      current user
GET    /openapi.json, /api/docs                 generated spec and Scalar API reference

GET    /s/{publicId}                            participant page (no cookies)
GET    /api/v1/public/surveys/{publicId}        latest published version: model, privacy statement, status
POST   /api/v1/public/surveys/{publicId}/responses   submit {versionId, answers, ticket, hp?} (no identifier)
```

Outside your groups everything is 404; a role too low within your group is 403 ([ADR 0009](adr/0009-group-rbac-404.md)). Someone who has not signed in yet is invited by email; the invite becomes a membership at their first sign-in with a verified email ([ADR 0016](adr/0016-pending-invites.md)).

Idempotent upserts by slug allow a GitOps flow. Publishing is always an explicit human action.

Events and surveys (#6):
- Slugs are lowercase letters, digits and single hyphens (max 64). Event slugs are unique per group, so `/groups/{g}/events/{e}` takes a slug and `/events/{e}` takes the event id. Survey slugs are unique per event.
- Action paths are `/validate` and `/publish`, not `:validate` / `:publish` (Hono routing treats `:` as a parameter).
- Drafts: creating needs no `If-Match`; changing an existing draft needs `If-Match` with the current ETag (or `*`): 428 without it, 412 on mismatch. ETags are opaque and change on every write. Invalid drafts are saved; the response carries the compile result (`{model}` or `{errors:[{line,column,message}]}`).
- Publish compiles the stored draft (422 with line-numbered errors if invalid) and inserts the next immutable version. `privacyStatement`, `opensAt`, `closesAt` left out of the body are inherited from the latest version; the privacy statement defaults to a template. If draft and settings equal the latest version, publish returns it (200) instead of creating a new one.
- Close/reopen is `surveys.closed_at` (set = closed), not a version field: versions are immutable, and closing is an operational switch that applies to whichever version is live. `closes_at` on a version is the scheduled end.
- In an archived group, event and survey writes return 409; reads still work.

Participant API (#7, [ADR 0011](adr/0011-participant-page.md)):
- `publicId` is a random 12-character id on `surveys` (returned by the staff survey GET), not the slugs.
- GET returns `status: open | closed | not_yet_open`; closed (`closed_at`, or `closes_at` past) wins. 404 until published.
- POST is JSON only (415 otherwise), at most 64 KB (413). Errors: 404 unknown, 429 rate limited, 410 closed, **403 not yet open**, 409 `versionId` is not the latest, or the ticket is invalid, older than 24 h or already used (client fetches the survey again for a fresh ticket, keeps the answers), 422 `{errors: {questionId: message}}` from `validateAnswers`. Stores answers, version and `submitted_at` only.
- Rate limits (ADR 0013): in-memory token buckets per survey (burst 1000, then 10/s) and per survey and client (300 per 10 min, keyed by HMAC of the IP with a daily-rotated in-memory key; never stored or logged); 429 carries `Retry-After`. Bot checks: honeypot `hp` and a signed load-time `ticket` with a 3 s minimum; failures get 201 and are not stored. Each ticket stores one response and expires after 24 h (ADR 0014). Single process only.

## Auth

OIDC (authorization code + PKCE, `openid-client`), configured by issuer, client id, client secret, redirect URI, allowed email domains and admin emails. Config comes from environment; on the CDSCI host the OAuth secrets come from GCP Secret Manager at deploy, other deployers set them however they manage secrets. Google is the first provider. Server-side sessions; the staff cookie is scoped to `/api/v1` and never set or read on participant routes ([ADR 0005](adr/0005-pluggable-oidc.md), [deploy guide](deploy-auth.md)). The OAuth client must have this app's redirect URI registered before it works.

## Conditionals and pages (phase 3 design)

- Safe expression grammar, never `eval`: `lang == 'Other' and years > 2`, same-survey answers only. In markdown: `show-if="..."` on the fenced div.
- One shared TypeScript evaluator (`packages/core`) runs in the browser and on the server, so the server can enforce required-if-visible and drop answers to hidden questions.
- Pages are separated by `---` or level-2 headings; submit once at the end, no drafts.
- No cross-wave conditions.

## Security notes

Permission tests (cross-group access, token handling, viewer rights) came first, then the threat model and an independent review of auth ([#33](https://github.com/seandavi/plainfeedback/issues/33), [review](reviews/2026-10-14-phase-1.md)). The participant endpoint has coarse rate limiting without IP logging (in memory, per process).

Threat model and residual risks: [`threat-model.md`](threat-model.md). Privacy statement template for authors: [`privacy-statement-template.md`](privacy-statement-template.md). Reverse proxy, CDN, backups and retention: [`deploy.md`](deploy.md). The review's deployment checklist is in [the review](reviews/2026-10-14-phase-1.md#deployment-checklist).

## Open questions

1. When (if ever) to add tokens/email for within-person linking.
2. Duplicate submissions from the shared link (accepted in v1; rate limiting only).
3. Whether to move beyond compose Postgres on onclappc02 (the preview instance uses the bundled one).
