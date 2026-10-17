# API guide

The reference is generated, not hand-written:

- Spec: `GET /openapi.json` (OpenAPI 3.1; committed snapshot at `docs/openapi.json`, regenerate with `just openapi`).
- Browsable docs: `/api/docs` (Scalar, all assets served by the app itself; no CDN or third-party requests).

## Authentication

| Scheme | How | Notes |
| --- | --- | --- |
| `sessionCookie` | Staff sign in through OIDC (`/api/v1/auth/login`); the `pf_session` cookie (Path=`/api/v1`) is then sent automatically. | Unsafe methods (POST/PUT/PATCH/DELETE) must carry an `Origin` header equal to the app origin (CSRF check). |
| `bearerToken` | `Authorization: Bearer pf_...` | Per-user API token for one group (see below). Bearer requests never use the cookie and need no `Origin`. |

Participant endpoints (`/s/*`, `/api/v1/public/*`) are anonymous and never set cookies; see [Participant endpoints](#participant-endpoints).
Errors are `{"error": "..."}` with 400 (also `issues`), 401, 403, 404, 409, 413 (any `/api/v1` body over 512 KB), 422 (publish of an invalid draft, with line-numbered `errors`) and 412/428 for draft concurrency. A group you are not a member of answers 404, not 403 (ADR 0009). An unknown path under `/api/` also answers `404 {"error": "not found"}`, never the web app's HTML.

## API tokens (automation)

Create one while signed in (session only; the secret is shown once):

```sh
curl -sS -X POST $BASE/api/v1/groups/$GROUP/tokens -H "Origin: $BASE" -b "pf_session=$PF_SESSION" \
  -H "Content-Type: application/json" -d '{"name":"ci","role":"creator","expiresInDays":90}' | jq -r .token
```

- Scoped to one group; `role` is `creator` or `viewer`, at most your own. The effective role is min(token role, your current role), so it never exceeds what you can do; removing you from the group revokes it for good (re-adding you does not revive it); it also stops when it expires (default 90 days, max 365) or it is revoked. Other groups answer 404.
- Then send `-H "Authorization: Bearer $PF_TOKEN"` instead of the cookie and `Origin` in the steps below.
- List with `GET /api/v1/groups/{g}/tokens` (owners see all of the group's tokens, others their own) or `GET /api/v1/me/tokens`; revoke with `DELETE /api/v1/groups/{g}/tokens/{id}`.
- Tokens cannot manage tokens, members, groups or users, and cannot log out (403). See ADR 0010.

## Members and invites

- `PUT /api/v1/groups/{g}/members/{user}` with `{"role": "viewer"}` (owner, session only). `{user}` is a user id or an email. A known user answers `200` with the membership.
- An email that nobody has signed in with yet answers **`202`** with `{"email", "role", "createdAt"}`. That is a pending invite, and it takes effect at the person's first sign-in with that email, verified by the identity provider. Repeating the PUT updates the invite's role. Emails are case-insensitive.
- `GET /api/v1/groups/{g}/invites` lists pending invites (any member). `DELETE /api/v1/groups/{g}/invites/{email}` revokes one (owner, session only). See ADR 0016.

## End to end with curl

Using the session cookie from a browser login (or a bearer token, above):

```sh
BASE=https://feedback.example.org   # PF_SESSION = value of the pf_session cookie
```

1. Upsert an event in a group (idempotent; `201` on create, `200` on replace). The response `id` is used below.

```sh
EVENT=$(curl -sS -X PUT $BASE/api/v1/groups/my-group/events/spring-2026 \
  -H "Origin: $BASE" -H "Content-Type: application/json" -b "pf_session=$PF_SESSION" \
  -d '{"title":"Spring workshop","startsOn":"2026-04-10","endsOn":"2026-04-11"}' | jq -r .id)
```

`startsOn` and `endsOn` are optional calendar dates (`YYYY-MM-DD`, no time of day); `endsOn` may not precede `startsOn`. The PUT replaces the event, so omitting a field clears it.

2. Create the survey draft (no `If-Match` needed on create; the `ETag` response header is the draft version).

```sh
curl -sS -i -X PUT $BASE/api/v1/events/$EVENT/surveys/feedback \
  -H "Origin: $BASE" -H "Content-Type: text/markdown" -b "pf_session=$PF_SESSION" \
  --data-binary @survey.md      # note the ETag header in the response
```

   To tag the survey as a wave, send JSON instead: `{"markdown": "...", "waveLabel": "pre"}`. `waveLabel` is one of `pre`, `post`, `followup`, `other`, or `null` (not a wave, the default, e.g. speaker feedback). An event may have at most one survey each of `pre`, `post` and `followup` (a second gets `409`); `other` can be used any number of times. Change it later with `PATCH /events/{e}/surveys/{s}` and `{"waveLabel": "post"}` (no `If-Match` needed). The markdown-only form leaves an existing wave unchanged.

3. Update the draft: `If-Match` must carry the current ETag (`*` to overwrite blindly). A stale ETag gives 412; a missing one on an existing draft gives 428.

```sh
curl -sS -X PUT $BASE/api/v1/events/$EVENT/surveys/feedback \
  -H "Origin: $BASE" -H "Content-Type: text/markdown" -b "pf_session=$PF_SESSION" \
  -H 'If-Match: "<etag>"' --data-binary @survey.md
```

4. Validate (dry run; no body checks the stored draft). Invalid drafts can be saved, but not published.

```sh
curl -sS -X POST $BASE/api/v1/events/$EVENT/surveys/feedback/validate \
  -H "Origin: $BASE" -b "pf_session=$PF_SESSION"
```

5. Publish the stored draft as a new immutable version.

```sh
curl -sS -X POST $BASE/api/v1/events/$EVENT/surveys/feedback/publish \
  -H "Origin: $BASE" -b "pf_session=$PF_SESSION"
```

   Once the survey has responses, publish answers 409 with a `changes` list when the draft would change what an existing export column means: a Likert statement reordered, inserted or reworded (anything but adding at the end), a question id reused with another type, an option removed or renamed (with `{value=...}`: an option value removed or changed; rewording its label is free), the Other label renamed, or a column name (such as `r_1`) now produced by a different question. Adding statements at the end, adding options and adding or removing questions are free. Send `{"force": true}` to publish anyway, for example after fixing a typo ([ADR 0015](adr/0015-export-column-stability.md)).

6. List published versions (newest first), or fetch one.

```sh
curl -sS $BASE/api/v1/events/$EVENT/surveys/feedback/versions -b "pf_session=$PF_SESSION"
curl -sS $BASE/api/v1/events/$EVENT/surveys/feedback/versions/1 -b "pf_session=$PF_SESSION"
```

## Share link and QR code

Viewer role or higher. Works before publishing too (`published` is false and the page answers 404 until a version exists).

```sh
curl -sS $BASE/api/v1/events/$EVENT/surveys/feedback/link -b "pf_session=$PF_SESSION"   # {"url":"$PUBLIC_BASE_URL/s/<publicId>","published":true}
curl -sS -OJ $BASE/api/v1/events/$EVENT/surveys/feedback/link/qr.svg -b "pf_session=$PF_SESSION"
curl -sS -OJ "$BASE/api/v1/events/$EVENT/surveys/feedback/link/qr.png?size=1024" -b "pf_session=$PF_SESSION"
```

The URL base is the server's `PUBLIC_BASE_URL`. QR codes are generated in the server (error correction M, 4-module quiet zone, no external service) and download as `<event>-<survey>-qr.svg|png`; `size` (64-2048, default 512) is the maximum PNG width in pixels. Responses are `Cache-Control: private`.

## Exporting responses

```sh
curl -sS "$BASE/api/v1/events/$EVENT/surveys/feedback/responses?format=csv" -b "pf_session=$PF_SESSION"
curl -sS "$BASE/api/v1/events/$EVENT/surveys/feedback/versions/1/codebook" -b "pf_session=$PF_SESSION"
curl -sS -OJ "$BASE/api/v1/events/$EVENT/responses?format=csv" -b "pf_session=$PF_SESSION"   # every survey of the event
curl -sS -OJ "$BASE/api/v1/groups/$GROUP/responses" -H "Authorization: Bearer $PF_TOKEN"       # every event of the group
```

Every row, in both formats, says where it came from: `eventId`, `eventSlug`, `eventTitle`, `eventStartsOn` (or empty), `surveyId`, `surveySlug`, `surveyTitle` (of that version), `waveLabel` (`pre`, `post`, `followup`, `other` or empty) and `surveyVersion`, so files from pre, post and follow-up surveys can be stacked without tagging by hand. Downloads are named `<event>-<survey>-responses.csv|jsonl` (event export `<event>-responses.*`, group export `<group id>-responses.*`). The codebook carries the same event and survey fields.

`GET /events/{e}/responses` exports every survey of an event and `GET /groups/{g}/responses` every survey in a group, with the same formats, `since` cursor, ordering and failure behaviour as the survey export (no `version`). Their CSV is one file whose columns are the union over all surveys and versions. That is deliberate: a pre and a post survey that share an id (`#confidence`) line up in one column. Publishing guards a column's meaning across versions of one survey, not across surveys, so a column means what the codebook of that row's `surveySlug` and `surveyVersion` says; check before aggregating a column across surveys. Admins can pull the whole deployment with `GET /api/v1/responses` (JSONL only, same `since`; session cookie only, since API tokens are never admins, so other users get 403). A cross-group token for automation needs a decision first ([#98](https://github.com/seandavi/plainfeedback/issues/98)); until then, loop over groups with one token each.

Viewer role or higher. `format=jsonl` (default) or `csv`; `version=<n>` limits to one version; rows are ordered by `seq`. `since` is either the `seq` of the last row you received (exclusive; this is the resume cursor) or an ISO time with an offset such as `2026-10-14T22:00:00Z`. An ISO `since` is a coarse filter, not a cursor: `submittedAt` is recorded to the hour only ([#37](https://github.com/seandavi/plainfeedback/issues/37)), so it returns everything from the start of that hour on, and `since=22:30Z` includes the 22:00 rows. Any other `since` is a 400. `seq` is assigned when a response is inserted, not when it commits, so a slow submission can become visible after a higher `seq` you already exported. To resume without losing rows, ask with an overlap (`since` = the highest `seq` you have minus 1000) and drop rows whose `responseId` you already have. If the export fails part way, the transfer is aborted rather than ended cleanly, so a truncated download shows up as a network error, not a short file. CSV is wide (multi answers joined with `;`, Likert as `<id>_<statement number>`, Other text in `<id>_other`, the fixed columns above first, union of columns across versions). The compiler refuses a question id that equals another question's column (`#r_1` next to a grid `#r`, `#c_other` next to `#c` with Other) or `seq`, so a header never repeats a name. Publishing keeps a column's meaning stable across versions unless an author forced a change (see publish above), so before aggregating a column across versions, check each version's codebook or export one `version` at a time. CSV is meant for spreadsheets: text cells that start with `=`, `+`, `-` or `@` (or their fullwidth forms `＝＋－＠`, also after leading whitespace), or with a tab or carriage return, get a leading single quote so a spreadsheet shows text instead of running a formula. That also changes legitimate text such as `-- nothing to add`. JSONL is the lossless format: answers exactly as stored, multi answers as arrays. Use it for analysis and text coding. Multi option labels never contain `;` (the compiler rejects it), so the CSV `;` join splits back exactly. Answers are stored normalised: strings trimmed, unrated Likert statements removed, and empty answers (`null`, `""`, `[]`, `{}`) left out, so a key present in JSONL means the same "answered" as a filled CSV cell. For choice and multi options with a `{value=...}`, the main column (and the multi `;` join, and JSONL) holds the value, not the option text; the codebook lists `options` (the text) and `values` (what is stored, parallel to `options`; equal to the text for options without a value). The codebook maps Likert statement numbers to text and lists scale anchors; `freeText: true` marks every question that can hold respondent-written text, including choice and multi questions with an Other box (the text is in `<id>_other`). Free text can identify people: treat it accordingly. Parquet is deferred: DuckDB and polars read these files directly.

## Deleting

Deletion is real (no soft delete) and cascades; backups keep data until they rotate ([deploy.md](deploy.md#retention-and-deletion), [ADR 0012](adr/0012-deletion-and-coarse-time.md)).

| Request | Who | Effect |
| --- | --- | --- |
| `DELETE /events/{e}/surveys/{s}/responses/{id}` | owner | One response by the `responseId` of the export; `204`. |
| `DELETE /events/{e}/surveys/{s}/responses[?before=<ISO time with offset>]` | owner | All responses of the survey, or those whose `submittedAt` (hour-truncated) is before `before` (exclusive); `{"deleted": n}`. |
| `DELETE /events/{e}/surveys/{s}` | owner; creator if never published | The survey, its versions and responses; `204`. |
| `DELETE /groups/{g}/events/{e}` (`{e}` is the slug) | owner | The event and everything under it; `204`. |
| `DELETE /groups/{g}` | admin, session only, once the group is archived (else 409) | The group and everything under it; `204`. |

In an archived group the first four answer 409.

## Participant endpoints

Anonymous, no cookies, `Cache-Control: no-store`; the web page at `/s/{publicId}` uses these ([ADR 0011](adr/0011-participant-page.md)). `publicId` is the random id from the share link.

- `GET /api/v1/public/surveys/{publicId}` returns the latest published version (model, privacy statement, `status`: `open`, `closed` or `not_yet_open`) and a `ticket`. 404 until published. Not rate limited.
- `POST /api/v1/public/surveys/{publicId}/responses` with `{"versionId", "answers", "ticket", "hp"?}`, JSON only (415 otherwise), at most 64 KB (413). `201 {"ok": true}` stores one response: the answers, the version and the submission time to the hour, nothing else.
- Each `ticket` is signed, valid for 24 h and **stores one response**: reusing it gets 409 and the client fetches the survey again for a new one ([ADR 0014](adr/0014-single-use-tickets-and-crowd-sized-limit.md)). A 422 or 429 leaves the ticket usable. Used tickets are tracked in memory per process; a restart invalidates every open ticket (409, and the page keeps the answers).
- Errors: 403 not open yet, 409 `versionId` is not the latest or the ticket is invalid, expired or used, 410 closed, 422 `{"error", "errors": {questionId: message}}` (answers are validated against the version; unknown keys are rejected), 429 rate limited.
- Rate limits ([ADR 0013](adr/0013-transient-client-rate-limit.md), [deploy.md](deploy.md#client-address-and-rate-limits)): one bucket per survey (burst 1000, then 10 per second) and one per survey and client address (300 per 10 minutes). Both answer 429 with `Retry-After` in seconds.
- Bot checks: a non-empty `hp`, or a submission less than 3 s after the ticket was issued, gets 201 and is not stored.
