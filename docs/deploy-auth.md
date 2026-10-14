# Deploying staff authentication (Google OIDC)

Staff sign in with OIDC (ADR 0005). Participants never sign in. This page covers the Google OAuth client, the redirect URI, and how production secrets reach the app.

## 1. Create or reuse the Google OAuth client

1. Google Cloud Console → **APIs & Services → OAuth consent screen**. Choose **Internal** if every staff member is in one Google Workspace; otherwise choose **External** and add the scopes `openid` and `email`.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type **Web application**.
3. Under **Authorized redirect URIs**, add the app's callback exactly:
   - production: `https://<your-host>/api/v1/auth/callback`
   - local dev: `http://localhost:3000/api/v1/auth/callback`

   The URI must match `OIDC_REDIRECT_URI` exactly (scheme, host, port, path, no trailing slash), or Google returns `redirect_uri_mismatch`. A redirect URI registered on the shared client applies to every app that uses that client, so add it rather than replacing existing entries.
4. Leave **Authorized JavaScript origins** empty; the browser never talks to Google directly.

The production client already exists. Its id and secret are in GCP Secret Manager, project `cdsci-infra`: `cancerdatasci-oauth-client-id` and `cancerdatasci-oauth-client-secret`. Registering the new redirect URI on that client is the only console step.

## 2. Configuration

| Variable | Required | Notes |
|---|---|---|
| `OIDC_CLIENT_ID` | yes | from Secret Manager |
| `OIDC_CLIENT_SECRET` | yes | from Secret Manager |
| `OIDC_REDIRECT_URI` | yes | `https://<your-host>/api/v1/auth/callback`; its origin is also the CSRF origin |
| `OIDC_ISSUER` | no | default `https://accounts.google.com`; any OIDC issuer with discovery |
| `OIDC_PROVIDER` | no | display name, default `Google` (`GET /api/v1/auth/provider`) |
| `ALLOWED_EMAIL_DOMAINS` | no | comma-separated, exact domain match; empty = any verified email |
| `ADMIN_EMAILS` | no | comma-separated; these users become admin when they sign in (first-admin bootstrap; never demotes) |
| `COOKIE_SECURE` | no | default `true`; set `false` only for plain-http localhost |
| `SESSION_TTL_HOURS` | no | default `12` |

If the client id, secret or redirect URI is missing, the server starts with auth disabled and logs a warning.

Behind a reverse proxy, the app must be reachable at the origin in `OIDC_REDIRECT_URI`. Login starts at `/api/v1/auth/login` and ends with a redirect to `/app`.

## 3. Injecting secrets at deploy

Never commit the values, put them in `.env` on a shared host, or print them (no `echo`, no `set -x`). Read them into the deploying shell's environment and let Compose pass them through (`compose.yaml` lists the variables without values):

```bash
export OIDC_CLIENT_ID="$(gcloud secrets versions access latest --secret=cancerdatasci-oauth-client-id --project=cdsci-infra)"
export OIDC_CLIENT_SECRET="$(gcloud secrets versions access latest --secret=cancerdatasci-oauth-client-secret --project=cdsci-infra)"
export OIDC_REDIRECT_URI="https://<your-host>/api/v1/auth/callback"
export ADMIN_EMAILS="you@example.org"
just migrate        # applies the sessions table migration
just up             # docker compose up; the variables are passed into the app container
```

The account running `gcloud` needs `roles/secretmanager.secretAccessor` on those two secrets. To rotate, add a new secret version, then redeploy with the commands above.

Tests never call Secret Manager or the network: they run the real `openid-client` flow against a fake identity provider.
