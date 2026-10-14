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
| Stack | FastAPI, Postgres, uv, justfile. Shared Postgres on onclappc02. |
| Authoring | Markdown is the source of truth. It compiles to a JSON survey model; the JSON is what is stored, rendered, validated and exported. |
| Renderer | Small custom renderer for a limited question set. SurveyJS Form Library (MIT) is the fallback. Survey Creator (paid) is not used. |
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
- `events` (belongs to a group, unique slug)
- `surveys` (belongs to an event; slug; wave label such as pre, post, followup; current draft markdown)
- `survey_versions` (immutable; markdown, compiled JSON model, privacy statement, open/close dates)
- `tokens` (deferred; event, hash of the code only)
- `responses` (survey_version, optional token hash, answers JSONB, submitted_at)
- `api_tokens` (user, group, role, hash, expiry)

## Survey JSON model

`pages[] -> questions[]`. Each question has a stable author-set slug `id`, `type` (choice, multi, likert, text, number), `required`, options or statements, and an optional `visibleIf` (unused until phase 3). Likert scale anchors are stored in the version so exports stay interpretable. Answers are keyed by question id.

## Markdown grammar (sketch, not final)

Pandoc-style fenced divs, as in `quarto-revealjs-live-questions`. Worked example, from the CFDE Fall 2026 meeting feedback form:

```markdown
# 2026 Fall Meeting Feedback

We want to hear your feedback. Your answers are anonymous. Agenda: [here](https://example.org).

::: {.choice #affiliation required other="Other"}
Please specify any CFDE affiliation(s).
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
- Free text can contain identifying details; viewers see a warning, and small groups can be re-identified from demographic fields (suppress small cells in aggregates).
- Chat and intake only see survey drafts and source documents, never responses. Respondent free text is untrusted input.
- Open: participant withdrawal by code; model provider disclosure for phase 2.

## API (`/api/v1`)

Staff authenticate with OIDC sessions or per-user API tokens scoped to a group and role (never above the owner's rights).

```
POST   /groups                                  admin
PUT    /groups/{g}/members/{user}               owner
DELETE /groups/{g}/members/{user}               owner
PUT    /groups/{g}/events/{e}                   creator: upsert by slug
PUT    /events/{e}/surveys/{s}                  creator: upsert draft from markdown (If-Match)
POST   /events/{e}/surveys/{s}:validate         dry run, line-numbered errors, model preview
POST   /events/{e}/surveys/{s}:publish          freeze a version
GET    /events/{e}/surveys/{s}/versions
GET    /events/{e}/surveys/{s}/link             public URL and QR code (SVG/PNG)
GET    /events/{e}/responses?format=jsonl|csv|parquet&since=   viewer

GET    /s/{event}/{survey}                      participant page (no cookies)
GET    /api/v1/public/surveys/{id}              model JSON
POST   /api/v1/public/surveys/{id}/responses    submit answers (no identifier)
```

Idempotent upserts by slug allow a GitOps flow. Publishing is always an explicit human action.

## Auth

A provider interface wrapping OIDC (Authlib): issuer, client id, client secret, redirect URI, allowed email domains. Config comes from environment, with secrets read from GCP Secret Manager. Google is the first provider. The OAuth client must have this app's redirect URI registered before it works.

## Conditionals and pages (phase 3 design)

- Safe expression grammar, never `eval`: `lang == 'Other' and years > 2`, same-survey answers only. In markdown: `show-if="..."` on the fenced div.
- Evaluated in the browser; the server stays lenient (types and choice membership, drops answers to hidden questions). A conformance test file allows a Python evaluator later.
- Pages are separated by `---` or level-2 headings; submit once at the end, no drafts.
- No cross-wave conditions.

## Security notes

Permission tests (cross-group access, token handling, viewer rights) come first, then a threat model and a second review of auth before real data. The participant endpoint needs coarse rate limiting without IP logging.

## Open questions

1. When (if ever) to add tokens/email for within-person linking.
2. Duplicate submissions from the shared link (accepted in v1; rate limiting only).
3. Where it runs (onclappc02 conventions in `monode/infrastructure/`; shared Postgres vs compose Postgres).
4. Editor design: split-pane markdown editor with live preview (decided in; details open).
