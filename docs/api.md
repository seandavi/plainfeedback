# API guide

The reference is generated, not hand-written:

- Spec: `GET /openapi.json` (OpenAPI 3.1; committed snapshot at `docs/openapi.json`, regenerate with `just openapi`).
- Browsable docs: `/api/docs` (Swagger UI, all assets served by the app itself; no CDN or third-party requests).

## Authentication

| Scheme | How | Notes |
| --- | --- | --- |
| `sessionCookie` | Staff sign in through OIDC (`/api/v1/auth/login`); the `pf_session` cookie (Path=`/api/v1`) is then sent automatically. | Unsafe methods (POST/PUT/PATCH/DELETE) must carry an `Origin` header equal to the app origin (CSRF check). |
| `bearerToken` | `Authorization: Bearer pf_...` | API tokens arrive with #11; the scheme is declared now. Bearer requests never use the cookie and need no `Origin`. |

Participant endpoints (`/s/*`, `/api/v1/public/*`) are anonymous and never set cookies.
Errors are `{"error": "..."}` with 400/401/403/404/409 (and 412/428 for draft concurrency). A group you are not a member of answers 404, not 403 (ADR 0009).

## End to end with curl

Until tokens exist, use the session cookie from a browser login:

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

## Coming

- Participant link and QR code (#9): not yet merged, so not in the spec.
- Response export (#10): not yet merged.
- API tokens (#11): will make `bearerToken` usable.

Update this section as those land (their routes appear in `/openapi.json` automatically).
