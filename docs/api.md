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

Viewer role or higher. `format=jsonl` (default) or `csv`; `version=<n>` limits to one version; rows are ordered by `seq`; `since` is exclusive and is the `seq` of the last row you received (to resume) or an ISO time (a coarse filter: `submittedAt` is recorded to the hour only, [#37](https://github.com/seandavi/plainfeedback/issues/37)). CSV is wide (multi answers joined with `;`, Likert as `<id>_<statement number>`, Other text in `<id>_other`, `seq` and `surveyVersion` columns, union of columns across versions). Cells starting with `=`, `+`, `-` or `@` get a leading single quote (formula-injection guard). The codebook maps Likert statement numbers to text and lists scale anchors and free-text questions. Parquet is deferred: DuckDB and polars read these files directly.

## Coming

- Participant link and QR code (#9): not yet merged, so not in the spec.

Update this section as those land (their routes appear in `/openapi.json` automatically).
