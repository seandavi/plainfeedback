# API guide

The reference is generated, not hand-written:

- Spec: `GET /openapi.json` (OpenAPI 3.1; committed snapshot at `docs/openapi.json`, regenerate with `just openapi`).
- Browsable docs: `/api/docs` (Swagger UI, all assets served by the app itself; no CDN or third-party requests).

## Authentication

| Scheme | How | Notes |
| --- | --- | --- |
| `sessionCookie` | Staff sign in through OIDC (`/api/v1/auth/login`); the `pf_session` cookie (Path=`/api/v1`) is then sent automatically. | Unsafe methods (POST/PUT/PATCH/DELETE) must carry an `Origin` header equal to the app origin (CSRF check). |
| `bearerToken` | `Authorization: Bearer pf_...` | Per-user API token for one group (see below). Bearer requests never use the cookie and need no `Origin`. |

Participant endpoints (`/s/*`, `/api/v1/public/*`) are anonymous and never set cookies.
Errors are `{"error": "..."}` with 400/401/403/404/409 (and 412/428 for draft concurrency). A group you are not a member of answers 404, not 403 (ADR 0009).

## API tokens (automation)

Create one while signed in (session only; the secret is shown once):

```sh
curl -sS -X POST $BASE/api/v1/groups/$GROUP/tokens -H "Origin: $BASE" -b "pf_session=$PF_SESSION" \
  -H "Content-Type: application/json" -d '{"name":"ci","role":"creator","expiresInDays":90}' | jq -r .token
```

- Scoped to one group; `role` is `creator` or `viewer`, at most your own. The effective role is min(token role, your current role), so it never exceeds what you can do; it stops working when you leave the group, it expires (default 90 days, max 365) or it is revoked. Other groups answer 404.
- Then send `-H "Authorization: Bearer $PF_TOKEN"` instead of the cookie and `Origin` in the steps below.
- List with `GET /api/v1/groups/{g}/tokens` (owners see all of the group's tokens, others their own) or `GET /api/v1/me/tokens`; revoke with `DELETE /api/v1/groups/{g}/tokens/{id}`.
- Tokens cannot manage tokens, members, groups or users, and cannot log out (403). See ADR 0010.

## End to end with curl

Using the session cookie from a browser login (or a bearer token, above):

```sh
BASE=https://feedback.example.org   # PF_SESSION = value of the pf_session cookie
```

1. Upsert an event in a group (idempotent; `201` on create, `200` on replace). The response `id` is used below.

```sh
EVENT=$(curl -sS -X PUT $BASE/api/v1/groups/my-group/events/spring-2026 \
  -H "Origin: $BASE" -H "Content-Type: application/json" -b "pf_session=$PF_SESSION" \
  -d '{"title":"Spring workshop"}' | jq -r .id)
```

2. Create the survey draft (no `If-Match` needed on create; the `ETag` response header is the draft version).

```sh
curl -sS -i -X PUT $BASE/api/v1/events/$EVENT/surveys/feedback \
  -H "Origin: $BASE" -H "Content-Type: text/markdown" -b "pf_session=$PF_SESSION" \
  --data-binary @survey.md      # note the ETag header in the response
```

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
```

Viewer role or higher. `format=jsonl` (default) or `csv`; `version=<n>` limits to one version; rows are ordered by `seq`. `since` is either the `seq` of the last row you received (exclusive; this is the resume cursor) or an ISO time with an offset such as `2026-10-14T22:00:00Z`. An ISO `since` is a coarse filter, not a cursor: `submittedAt` is recorded to the hour only ([#37](https://github.com/seandavi/plainfeedback/issues/37)), so it returns everything from the start of that hour on, and `since=22:30Z` includes the 22:00 rows. Any other `since` is a 400. `seq` is assigned when a response is inserted, not when it commits, so a slow submission can become visible after a higher `seq` you already exported. To resume without losing rows, ask with an overlap (`since` = the highest `seq` you have minus 1000) and drop rows whose `responseId` you already have. If the export fails part way, the transfer is aborted rather than ended cleanly, so a truncated download shows up as a network error, not a short file. CSV is wide (multi answers joined with `;`, Likert as `<id>_<statement number>`, Other text in `<id>_other`, `seq` and `surveyVersion` columns, union of columns across versions). CSV is meant for spreadsheets: text cells that start with `=`, `+`, `-` or `@` (or their fullwidth forms `＝＋－＠`, also after leading whitespace), or with a tab or carriage return, get a leading single quote so a spreadsheet shows text instead of running a formula. That also changes legitimate text such as `-- nothing to add`. JSONL is the lossless format: answers exactly as stored, multi answers as arrays. Use it for analysis and text coding. Multi option labels never contain `;` (the compiler rejects it), so the CSV `;` join splits back exactly. Answers are stored normalised: strings trimmed, unrated Likert statements removed, and empty answers (`null`, `""`, `[]`, `{}`) left out, so a key present in JSONL means the same "answered" as a filled CSV cell. The codebook maps Likert statement numbers to text and lists scale anchors; `freeText: true` marks every question that can hold respondent-written text, including choice and multi questions with an Other box (the text is in `<id>_other`). Free text can identify people: treat it accordingly. Parquet is deferred: DuckDB and polars read these files directly.

## Coming

- Participant link and QR code (#9): not yet merged, so not in the spec.

Update this section as those land (their routes appear in `/openapi.json` automatically).
