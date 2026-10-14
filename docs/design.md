# plainfeedback: design

De-identified event-feedback surveys for the Common Fund Data Ecosystem (CFDE) metrics grant. Open source, MIT licensed. Decisions are recorded in [`adr/`](adr/). Platform survey and rationale: [`research/platform-survey.md`](../research/platform-survey.md).

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
| Auth | Pluggable OIDC. Google is the default for development; the client id and secret are in GCP Secret Manager (`cdsci-infra`: `cancerdatasci-oauth-client-id`, `cancerdatasci-oauth-client-secret`). |
| Participants | v1: shared anonymous link and QR code, no tokens, no email ([ADR 0004](adr/0004-anonymous-link-only-v1.md)). |
| Deployment | Docker Compose ([ADR 0006](adr/0006-docker-compose.md)). |
| Chat layer | Edits the markdown, never the JSON. Phase 2. |
| Conditionals, pages | Phase 3. The JSON model has the slots from phase 1. |

## Phases

1. **Core**: groups and roles, API, markdown to JSON, single-page renderer, web markdown editor with live preview, publish with shareable link and QR code, export.
2. **Chat**: markdown-editing assistant with live preview, blank-page start with suggested prompts, intake from pasted text or uploaded documents.
3. **Conditionals and multiple pages**: grammar and renderer extensions; update the chat's grammar spec and examples.

## Data model

- `users` (`is_admin`), `groups`, `memberships(group, user, role: owner|creator|viewer)`
- `events` (belongs to a group, slug unique per group, title, description)
- `surveys` (belongs to an event; slug; wave label such as pre, post, followup; current draft markdown and ETag; `closed_at`)
- `survey_versions` (immutable; markdown, compiled JSON model, privacy statement, open/close dates)
- `tokens` (deferred; event, hash of the code only)
- `responses` (survey_version, optional token hash, answers JSONB, submitted_at to the hour, seq for export order)
- `api_tokens` (user, group, role, hash, expiry)

## Survey JSON model

`pages[] -> questions[]`. Each question has a stable author-set slug `id`, `type` (choice, multi, likert, text, number), `required`, options or statements, and an optional `visibleIf` (unused until phase 3). Likert scale anchors are stored in the version so exports stay interpretable. Answers are keyed by question id.

## Markdown grammar (sketch, not final)

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
PUT    /groups/{g}/members/{user}               owner: {user} is an id or the email of an existing user
DELETE /groups/{g}/members/{user}               owner (never the last owner)
GET    /users                                   admin
PATCH  /users/{id}                              admin: grant/revoke admin (never the last admin)
GET    /groups/{g}/events                       viewer
GET    /groups/{g}/events/{e}                   viewer ({e} is the event slug here)
PUT    /groups/{g}/events/{e}                   creator: upsert by slug {title, description}; returns the event id
DELETE /groups/{g}/events/{e}                   owner: cascades to surveys and responses
GET    /events/{e}/surveys                      viewer ({e} is the event id)
GET    /events/{e}/surveys/{s}                  viewer: draft markdown, ETag, latest version summary
PUT    /events/{e}/surveys/{s}                  creator: upsert draft (text/markdown or JSON); If-Match to update
PATCH  /events/{e}/surveys/{s}                  creator: {closed} stops or resumes accepting responses
DELETE /events/{e}/surveys/{s}                  owner; creator if never published. Cascades
POST   /events/{e}/surveys/{s}/validate         viewer: dry run of supplied or stored markdown, no writes
POST   /events/{e}/surveys/{s}/publish          creator: freeze the draft as a new version
GET    /events/{e}/surveys/{s}/versions         viewer
GET    /events/{e}/surveys/{s}/versions/{n}     viewer
GET    /events/{e}/surveys/{s}/link             viewer: public URL + published flag
GET    /events/{e}/surveys/{s}/link/qr.svg|png  viewer: QR code of that URL (png: ?size=)
GET    /events/{e}/surveys/{s}/responses?format=jsonl|csv&since=<seq|ISO>   viewer
DELETE /events/{e}/surveys/{s}/responses?before=  owner: returns the count
DELETE /events/{e}/surveys/{s}/responses/{id}     owner

GET    /s/{publicId}                            participant page (no cookies)
GET    /api/v1/public/surveys/{publicId}        latest published version: model, privacy statement, status
POST   /api/v1/public/surveys/{publicId}/responses   submit {versionId, answers, ticket, hp?} (no identifier)
```

Outside your groups everything is 404; a role too low within your group is 403 ([ADR 0009](adr/0009-group-rbac-404.md)). Members must have signed in once before they can be added; invitations come later.

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
- POST is JSON only (415 otherwise), at most 64 KB (413). Errors: 404 unknown, 429 rate limited, 410 closed, **403 not yet open**, 409 `versionId` is not the latest (client reloads), 422 `{errors: {questionId: message}}` from `validateAnswers`. Stores answers, version and `submitted_at` only.
- Rate limits (ADR 0013): in-memory token buckets per survey (burst 1000, then 10/s) and per survey and client (30 per 10 min, keyed by HMAC of the IP with a daily-rotated in-memory key; never stored or logged). Bot checks: honeypot `hp` and a signed load-time `ticket` with a 3 s minimum; failures get 201 and are not stored. Single process only.

## Auth

OIDC (authorization code + PKCE, `openid-client`), configured by issuer, client id, client secret, redirect URI, allowed email domains and admin emails. Config comes from environment, with secrets read from GCP Secret Manager at deploy. Google is the first provider. Server-side sessions; the staff cookie is scoped to `/api/v1` and never set or read on participant routes ([ADR 0005](adr/0005-pluggable-oidc.md), [deploy guide](deploy-auth.md)). The OAuth client must have this app's redirect URI registered before it works.

## Conditionals and pages (phase 3 design)

- Safe expression grammar, never `eval`: `lang == 'Other' and years > 2`, same-survey answers only. In markdown: `show-if="..."` on the fenced div.
- One shared TypeScript evaluator (`packages/core`) runs in the browser and on the server, so the server can enforce required-if-visible and drop answers to hidden questions.
- Pages are separated by `---` or level-2 headings; submit once at the end, no drafts.
- No cross-wave conditions.

## Security notes

Permission tests (cross-group access, token handling, viewer rights) come first, then a threat model and a second review of auth before real data. The participant endpoint needs coarse rate limiting without IP logging.

Threat model and residual risks: [`threat-model.md`](threat-model.md). Privacy statement template for authors: [`privacy-statement-template.md`](privacy-statement-template.md). Reverse proxy, CDN, backups and retention: [`deploy.md`](deploy.md). The independent auth review is #33.

## Open questions

1. When (if ever) to add tokens/email for within-person linking.
2. Duplicate submissions from the shared link (accepted in v1; rate limiting only).
3. Where it runs (onclappc02 conventions in `monode/infrastructure/`; shared Postgres vs compose Postgres).
4. Editor design: split-pane markdown editor with live preview (decided in; details open).
