# 0005. Pluggable OIDC for staff authentication

- Status: accepted
- Date: 2026-10-14 (amended for issue #3)

## Decision
Staff sign in with OIDC: authorization code + PKCE + state + nonce, using `openid-client` v6 (built on WebCrypto and fetch, so it also runs on Cloudflare Workers). Any OIDC issuer works by configuration (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_PROVIDER` display name); Google is the default. A verified email is required; `ALLOWED_EMAIL_DOMAINS` optionally restricts domains (exact match); `ADMIN_EMAILS` promotes matching users to admin on login (promote only). Users are keyed by (issuer, subject). Secrets come from GCP Secret Manager in production (see `docs/deploy-auth.md`). Participants never authenticate.

Sessions are server-side: a random 256-bit id in a cookie, only its SHA-256 stored in `sessions` with an expiry. Logout (POST) deletes the row.

### Cookies: staff routes only
- The staff session cookie `pf_session` is `HttpOnly; Secure; SameSite=Lax; Path=/api/v1`. A cookie has a single path prefix, so it cannot be limited to a list of route trees. `/api/v1` is the narrowest prefix that covers the staff API, including login and logout under `/api/v1/auth`. Browsers therefore never send it to `/s/*` or to the SPA.
- `/api/v1/public/*` (participant API) does receive the cookie because of the prefix, but the server never reads it there: session middleware skips participant paths, and `participantGuard` strips any `Set-Cookie` from `/s/*` and `/api/v1/public/*`. Tests cover both.
- The login transaction cookie (`pf_oidc`: state, nonce and PKCE verifier) is `Path=/api/v1/auth`, lasts 10 minutes and is cleared on callback.
- Participant routes remain cookie-free.

### CSRF
A cookie-authenticated unsafe request (POST/PUT/PATCH/DELETE) must carry an `Origin` header equal to the origin of `OIDC_REDIRECT_URI`. Requests without `Origin` are rejected; SameSite=Lax is the second layer. Requests that carry an `Authorization` header never use the cookie. That is the seam for API bearer tokens, which need no CSRF check; see [ADR 0010](0010-api-tokens.md).

## Consequences
Other providers (ORCID, institutional) can be added by configuration. The OAuth client must have this app's redirect URI, `https://<host>/api/v1/auth/callback`, registered. If the participant API ever moves out of `/api/v1/public`, the cookie path still holds; if staff routes move outside `/api/v1`, revisit the cookie path.
