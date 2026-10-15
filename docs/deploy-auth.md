# Deploying staff authentication (Google OIDC)

Staff sign in with OIDC (ADR 0005). Participants never sign in. This page covers the Google OAuth client, the redirect URI, and how production secrets reach the app. Reverse proxy, TLS, logging, backups and retention are in [deploy.md](deploy.md).

## 1. Create or reuse the Google OAuth client

1. Google Cloud Console → **APIs & Services → OAuth consent screen**. Choose **Internal** if every staff member is in one Google Workspace; otherwise choose **External** and add the scopes `openid` and `email`.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type **Web application**.
3. Under **Authorized redirect URIs**, add the app's callback exactly:
   - production or any public host: `https://<host>/api/v1/auth/callback` (for the preview instance, `https://plainfeedback.cancerdatasci.org/api/v1/auth/callback`)
   - local dev: `http://localhost:3000/api/v1/auth/callback`

   The URI must match `OIDC_REDIRECT_URI` exactly (scheme, host, port, path, no trailing slash), or Google returns `redirect_uri_mismatch`. A redirect URI registered on the shared client applies to every app that uses that client, so add it rather than replacing existing entries.
4. Leave **Authorized JavaScript origins** empty; the browser never talks to Google directly.

On the CDSCI deployment the client already exists. Its id and secret are in GCP Secret Manager, project `cdsci-infra`: `cancerdatasci-oauth-client-id` and `cancerdatasci-oauth-client-secret`. Registering the new redirect URI on that client is the only console step.

## 2. Configuration

| Variable | Required | Notes |
|---|---|---|
| `OIDC_CLIENT_ID` | yes | from Secret Manager |
| `OIDC_CLIENT_SECRET` | yes | from Secret Manager |
| `OIDC_REDIRECT_URI` | yes | `https://<your-host>/api/v1/auth/callback`; its origin is also the CSRF origin |
| `PUBLIC_BASE_URL` | yes | Public origin, e.g. `https://feedback.example.org`; survey links and QR codes are `${PUBLIC_BASE_URL}/s/{publicId}` |
| `OIDC_ISSUER` | no | default `https://accounts.google.com`; any OIDC issuer with discovery |
| `OIDC_PROVIDER` | no | display name, default `Google` (`GET /api/v1/auth/provider`) |
| `ALLOWED_EMAIL_DOMAINS` | no | comma-separated, exact domain match; empty = any verified email. With Google as the issuer, the `hd` (Workspace hosted domain) claim must also be one of these, so personal Google accounts registered on an org address are refused. Other issuers have no standard equivalent: only the email is checked, so allow only domains whose accounts that issuer controls. |
| `ADMIN_EMAILS` | no | comma-separated; these users become admin when they sign in (first-admin bootstrap; never demotes). **Empty it once the first admin exists**: while set, any login with that verified email from the issuer is promoted. Requires `ALLOWED_EMAIL_DOMAINS`: the app refuses to start otherwise, since without it no `hd` check stops a personal account on that address. |
| `COOKIE_SECURE` | no | default `true`; set `false` only for plain-http localhost |
| `SESSION_TTL_HOURS` | no | default `12`; absolute session lifetime |
| `SESSION_IDLE_HOURS` | no | default `2`; a session unused this long ends |

If the client id, secret or redirect URI is missing, the server starts with auth disabled and logs a warning.

Behind a reverse proxy, the app must be reachable at the origin in `OIDC_REDIRECT_URI`. Login starts at `/api/v1/auth/login` and ends with a redirect to `/app`.

**Off-boarding.** Disabling someone at the identity provider stops new logins only. To end their access here at once, an admin disables them under **Administration → Users** (`PATCH /api/v1/users/{id}` with `{"disabled": true}`): their sessions are deleted, their API tokens are revoked for good, and logins are refused until an admin enables them again. The last active admin cannot be disabled.

## Gmail and other consumer Google accounts

Consumer Google accounts (`@gmail.com`) carry no `hd` claim. When `ALLOWED_EMAIL_DOMAINS` is set and the issuer is Google, only accounts whose `hd` is on the list can sign in, so Gmail users are refused. And `ADMIN_EMAILS` needs `ALLOWED_EMAIL_DOMAINS` (the app refuses to start otherwise), so it cannot bootstrap a Gmail admin either. For a Gmail-only setup:

1. Leave `ALLOWED_EMAIL_DOMAINS` and `ADMIN_EMAILS` empty. Any verified Google account can then sign in, but sees nothing until an admin or group owner adds them to a group.
2. Sign in once, so your user row exists.
3. Promote yourself in the database, as the owner role:

```bash
docker compose exec -T db psql -U plainfeedback -d plainfeedback \
  -c "update users set is_admin = true where email = 'you@gmail.com';"
```

Further admins can then be granted under **Administration → Users**. Because anyone with a Google account may sign in, add people to groups deliberately.

## 3. Injecting secrets at deploy

Never commit the values, put them in `.env` on a shared host, or print them (no `echo`, no `set -x`). Read them into the deploying shell's environment and let Compose pass them through (`compose.yaml` lists the variables without values):

```bash
export OIDC_CLIENT_ID="$(gcloud secrets versions access latest --secret=cancerdatasci-oauth-client-id --project=cdsci-infra)"
export OIDC_CLIENT_SECRET="$(gcloud secrets versions access latest --secret=cancerdatasci-oauth-client-secret --project=cdsci-infra)"
export OIDC_REDIRECT_URI="https://<your-host>/api/v1/auth/callback"
export ALLOWED_EMAIL_DOMAINS="example.org"
export ADMIN_EMAILS="you@example.org"
just up             # docker compose up --build; the variables are passed into the app container
just migrate        # with DATABASE_URL set to the owner role (first-run sequence: deploy.md)
```

The account running `gcloud` needs `roles/secretmanager.secretAccessor` on those two secrets. To rotate, add a new secret version, then redeploy with the commands above.

Tests never call Secret Manager or the network: they run the real `openid-client` flow against a fake identity provider.
