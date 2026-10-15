# Deploying plainfeedback

The app avoids collecting participant identifiers, but everything in front of it (reverse proxy, CDN, host) can still log them. This page is what a deployer must configure so the [privacy statement](privacy-statement-template.md) stays true. Staff sign-in (OIDC client, secrets) is in [deploy-auth.md](deploy-auth.md). Why each step matters: [threat-model.md](threat-model.md).

## Shape

```
Internet ──TLS──> [optional CDN] ──> reverse proxy (TLS, HSTS, no IP logs) ──> app 127.0.0.1:3000 ──> Postgres (compose network)
```

- Run with `just up` (Docker Compose, [ADR 0006](adr/0006-docker-compose.md)). `compose.yaml` publishes the app on `127.0.0.1:3000` only (`APP_BIND`, `APP_PORT` override it) and Postgres on `127.0.0.1:5432`. Keep both off public interfaces; all traffic must pass the proxy.
- The app does not terminate TLS. It uses the client address for one thing: a per-client limit on survey submissions ([ADR 0013](adr/0013-transient-client-rate-limit.md)). The address is HMACed with a random in-memory key that is replaced every 24 hours, and neither the address nor the key is stored or logged. See [client address and rate limits](#client-address-and-rate-limits).

## First run

On a new host, with Docker, Node 22, pnpm and [`just`](https://just.systems) installed (`just migrate` runs on the host, from this checkout):

1. `pnpm install` and `cp .env.example .env`. Set `PUBLIC_BASE_URL`, real `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` (URL-safe), `TRUST_PROXY`, and the staff-auth variables ([deploy-auth.md](deploy-auth.md)).
2. `just up` (`docker compose up --build -d --wait`). On a new volume the db container creates the `plainfeedback_app` role. The app starts but its tables do not exist yet.
3. `just migrate` with `DATABASE_URL` set to the **owner** role, not the app role (the db port is published on loopback):
   ```bash
   export DATABASE_URL="postgresql://plainfeedback:${POSTGRES_PASSWORD}@localhost:5432/plainfeedback"
   just migrate
   ```
   Migrations are never run on app start. This step also makes `responses` and `survey_versions` append-only for the app role ([database roles](#database-roles)). Rerun it after every upgrade.
4. Put the TLS proxy in front ([reverse proxy](#reverse-proxy-no-ip-or-user-agent-logs)) and check `curl localhost:3000/healthz`.
5. Sign in at `https://<host>/app`. With a Workspace domain, set `ALLOWED_EMAIL_DOMAINS` and `ADMIN_EMAILS` for the first sign-in, then **empty `ADMIN_EMAILS`** and redeploy. For a Gmail-only setup, promote yourself in SQL after first login ([deploy-auth.md](deploy-auth.md#gmail-and-other-consumer-google-accounts)):
   ```bash
   docker compose exec -T db psql -U plainfeedback -d plainfeedback \
     -c "update users set is_admin = true where email = 'you@gmail.com';"
   ```
6. As admin, create a group and add its owner (members must have signed in once). Work through [Before real data](#before-real-data).

## Settings that must be right

| Setting | Production value | Why |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://feedback.example.org` (no trailing slash) | Survey links and QR codes are `${PUBLIC_BASE_URL}/s/{publicId}`. An `http://` value prints insecure links on posters. |
| `OIDC_REDIRECT_URI` | `https://feedback.example.org/api/v1/auth/callback` | Same origin as `PUBLIC_BASE_URL`. Its origin is also the CSRF origin: staff writes from any other origin are rejected. Register it with the IdP ([deploy-auth.md](deploy-auth.md)). |
| `COOKIE_SECURE` | unset (defaults to `true`) | `false` is for plain-http localhost only. |
| `ALLOWED_EMAIL_DOMAINS` | your staff domain(s) | Empty means any verified email at the issuer can sign in (they see nothing until added to a group, but can still sign in). |
| `ADMIN_EMAILS` | first admin only, then empty | Promotes on every login while set. The app refuses to start if it is set while `ALLOWED_EMAIL_DOMAINS` is empty. |
| `POSTGRES_PASSWORD` | a real secret | The owner role, used by `just migrate` and backups. The compose default is for local dev. |
| `APP_DB_PASSWORD` | a different real secret, URL-safe | The app's role, `plainfeedback_app`. [Database roles](#database-roles). |
| `TRUST_PROXY` | the header your proxy overwrites, usually `x-forwarded-for` | Without it, everyone behind a local proxy looks like one client and the per-client limit is off. [Details](#client-address-and-rate-limits). |

## Client address and rate limits

Survey submissions are limited twice, in memory, per process ([#34](https://github.com/seandavi/plainfeedback/issues/34)):

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_SURVEY_BURST`, `RATE_LIMIT_SURVEY_PER_SECOND` | `1000`, `10` | Everyone answering one survey, together. |
| `RATE_LIMIT_CLIENT_MAX`, `RATE_LIMIT_CLIENT_WINDOW_MINUTES` | `300`, `10` | One client address (IPv6: its /64) per survey. Attendees on one conference Wi-Fi share an address; see sizing below. |

Both limits answer 429 with `Retry-After`. The participant page waits and resends by itself when the wait is 30 s or less; otherwise people see "A lot of answers have come from your network in the last few minutes... please wait a moment and submit again", and their answers stay on the page. Each page load also gets a ticket that stores one response and expires after 24 h ([ADR 0014](adr/0014-single-use-tickets-and-crowd-sized-limit.md)).

**Sizing `RATE_LIMIT_CLIENT_MAX`.** Set it to at least the number of people who may answer from one network within 10 minutes: at a closing-slide QR code that is most of the room. The default 300 covers a room of about 300 on one Wi-Fi; for 500, set 500 or more. The limit refills steadily (300 per 10 min is one every 2 s), so a larger crowd is slowed, not shut out. A higher limit also lets one script add more responses ([threat model](threat-model.md), row 1); single-use tickets make it load the page for every response but do not stop it.

Where the client address comes from, `TRUST_PROXY`:

- unset: the TCP peer. Use this only when the app is reachable directly. If the peer is a loopback or private address (a proxy on the same host or network), the per-client limit is skipped, because every participant would share that address; the app logs one warning (without the address) the first time this happens.
- `x-forwarded-for`: the **rightmost** entry, which is the one your proxy added. Entries to its left are whatever the client sent. Make the proxy overwrite or append the header (nginx: `proxy_set_header X-Forwarded-For $remote_addr;`; Caddy and Traefik do it by default), and keep the app unreachable except through the proxy (compose binds it to `127.0.0.1`).
- `cf-connecting-ip`: Cloudflare's header. Use it when Cloudflare is in front of your proxy (with Cloudflare plus a proxy, the rightmost `X-Forwarded-For` entry is a Cloudflare edge address). Only safe if the origin accepts traffic from Cloudflare alone; otherwise anyone can send the header.

Choosing the wrong one either makes everyone one client (too strict) or lets each client pick its own key (no per-client limit). The per-survey limit applies either way.

Two identity-free bot checks also run: a hidden form field that people never see, and a minimum of 3 seconds between loading the page and submitting. Submissions that fail them get a normal "thank you" and are not stored.

## Reverse proxy: no IP or user-agent logs

Goal: no log line that ties a client IP or user agent to a participant request. Participant requests are `/s/*` (the page), `/assets/*` (its JavaScript and CSS) and `/api/v1/public/*` (load and submit). The simplest correct setting is **no access log for the whole site**. If you need logs for staff traffic, drop the participant paths and strip IPs from the rest.

The app helps: participant pages send `Referrer-Policy: no-referrer`, so the `/assets/*` requests do not carry `Referer: /s/{publicId}`. A log that keeps IPs for `/assets/*` still shows who loaded the app and when.

Error logs count too. nginx's `error_log` lines include `client: <ip>` (for example on a 413 or an upstream error) even with `access_log off`.

### Caddy (2.9 or later)

Caddy writes no access log unless a site has a `log` directive. The minimal config is also the most private one:

```caddyfile
feedback.example.org {
	encode zstd gzip
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	reverse_proxy 127.0.0.1:3000
}
```

If you want staff request logs, skip participant paths and delete client fields from what is left:

```caddyfile
feedback.example.org {
	log {
		output file /var/log/caddy/feedback.log {
			roll_keep_for 168h
		}
		format filter {
			wrap json
			request>remote_ip delete
			request>client_ip delete
			request>remote_port delete
			request>headers delete
			request>uri query {
				delete *
			}
		}
	}
	log_skip /s/*
	log_skip /api/v1/public/*
	log_skip /assets/*
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	reverse_proxy 127.0.0.1:3000
}
```

`log_skip` was called `skip_log` before Caddy 2.9. Caddy gets and renews TLS certificates itself. Both snippets pass `caddy validate`.

### nginx

```nginx
# In the http {} context. No IP, no user agent, no referer, no query string.
log_format pf_noip '$time_iso8601 "$request_method $uri" $status $body_bytes_sent $request_time';

# Optional per-IP limit for participant requests. The key lives only in shared memory, never in a log.
# Each response is a GET and a POST; size it like RATE_LIMIT_CLIENT_MAX (a conference shares one IP).
limit_req_zone $binary_remote_addr zone=pf_submit:10m rate=120r/m;

server {
    listen 80;
    server_name feedback.example.org;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name feedback.example.org;

    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Overrides the global access_log (whose default "combined" format has IP and user agent).
    access_log /var/log/nginx/feedback.access.log pf_noip;   # or: access_log off;
    # error_log lines carry "client: <ip>"; crit keeps only server failures.
    error_log  /var/log/nginx/feedback.error.log crit;

    client_max_body_size 1m;

    # Overwrites whatever the client sent; the app reads it with TRUST_PROXY=x-forwarded-for.
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;

    location / {
        proxy_pass http://127.0.0.1:3000;
    }
    location /s/      { access_log off; proxy_pass http://127.0.0.1:3000; }
    location /assets/ { access_log off; proxy_pass http://127.0.0.1:3000; }
    location /api/v1/public/ {
        access_log off;
        limit_req zone=pf_submit burst=600 nodelay;
        limit_req_status 429;
        limit_req_log_level info;   # rejected requests are logged to error_log with the IP; crit hides them
        proxy_pass http://127.0.0.1:3000;
    }
}
```

The nginx per-IP limit is optional now that the app has its own per-client limit; it uses the IP only in memory. People behind one conference NAT share an IP, so keep it generous. This config passes `nginx -t`.

### Traefik (the CDSCI host, onclappc02)

Traefik's access log is global static config. On onclappc02 it keeps `ClientHost`, `User-Agent`, `X-Forwarded-For` and `Cf-Connecting-Ip` and ships them to ClickHouse for 90 days (see `monode/infrastructure/INDEX.md`, "Traefik access logging"). Turn it off for this app's router with a label:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.plainfeedback.rule=Host(`feedback.example.org`)
  - traefik.http.routers.plainfeedback.entrypoints=websecure
  - traefik.http.routers.plainfeedback.tls.certresolver=letsencrypt
  - traefik.http.routers.plainfeedback.observability.accessLogs=false
  - traefik.http.services.plainfeedback.loadbalancer.server.port=3000
```

Then confirm that a request to `/s/...` produces no new line in the access log (and no row in `traefik_access_log`). Use the entrypoint and cert resolver names from that host's Traefik config. If the app joins the `proxy` network, remove the `ports:` mapping from `compose.yaml` instead of binding it to the host.

## TLS and HSTS

Serve only over HTTPS. Redirect port 80 to 443 and send `Strict-Transport-Security`. Session cookies are `Secure` by default and do not work over plain http. Survey links in posters and QR codes are permanent, so get `PUBLIC_BASE_URL` right before printing.

## Cloudflare

If the hostname is proxied through Cloudflare (orange cloud), Cloudflare terminates TLS and sees every request in clear: IP, user agent and the submitted answers, free text included. It keeps its own logs and analytics. The app cannot change that. If you use it:

- Name Cloudflare in the survey's privacy statement (the template has an optional sentence).
- Turn off features that set cookies or inject scripts, or the "no cookies" claim is false: **Bot Fight Mode** (sets `__cf_bm`; cannot be skipped per path, only turned off for the zone), **JavaScript detections and challenges** (set `cf_clearance`), **Web Analytics / Browser Insights**, **Rocket Loader**, **Email Obfuscation**, **Zaraz**. The participant page's CSP blocks injected third-party scripts, so they mostly break things rather than track, but cookies set by Cloudflare's edge are not affected by CSP.
- If your proxy logs `Cf-Connecting-Ip` (Traefik on onclappc02 does), the steps above apply: it is the participant's IP.
- A grey-cloud (DNS only) record avoids all of this; then only your own proxy sees traffic.

## Postgres

### Database roles

The app does not connect as the table owner ([#76](https://github.com/seandavi/plainfeedback/issues/76)):

- `plainfeedback` (owner, `POSTGRES_PASSWORD`) owns the schema. `just migrate` and `pg_dump` use it, with `DATABASE_URL` in the deploying shell or `.env`.
- `plainfeedback_app` (`APP_DB_PASSWORD`) may only read and write rows: no `ALTER`, `DROP`, `TRUNCATE` or `TRIGGER`, and no `UPDATE` on `responses` or `survey_versions` (append-only; deletion is `DELETE`). So it cannot disable the trigger that keeps published survey versions immutable. `compose.yaml` gives the app this role in its `DATABASE_URL`.

On a new database volume, the postgres container creates the role on first start from `db/` (`10-app-role.sh`, then `20-app-grants.sql`; the default privileges there cover tables that later migrations add). The scripts run before any table exists, so the `REVOKE UPDATE` on `responses` and `survey_versions` is a migration (`0011_revoke_app_update`), applied by `just migrate` once the role exists ([#103](https://github.com/seandavi/plainfeedback/issues/103)). Run `just migrate` after the first `docker compose up` ([first run](#first-run)); the app is not append-only before that.

The `db` service is built from `db/Dockerfile`, which copies the scripts into the image with fixed permissions, so a strict host umask (e.g. 027) cannot make them unreadable to the container's `postgres` user. After editing `db/`, run `docker compose up -d --build db`.

**Existing deployments** (a database created before this change): set `APP_DB_PASSWORD`, run `just migrate`, then once:

```bash
docker compose up -d --build --wait db   # recreates db with APP_DB_PASSWORD and the db/ scripts
docker compose exec -T db sh /docker-entrypoint-initdb.d/10-app-role.sh
docker compose exec -T db psql -U plainfeedback -d plainfeedback -v ON_ERROR_STOP=1 \
  -f /docker-entrypoint-initdb.d/20-app-grants.sql
just up                          # the app now connects as plainfeedback_app
```

The second step also revokes `UPDATE` on `responses` and `survey_versions` from the app role ([#100](https://github.com/seandavi/plainfeedback/issues/100)) when the tables exist, so deployments that ran it before must rerun it. If you created the role after running `just migrate`, rerunning the grants fixes that too. Both steps are safe to repeat; rerunning the first one sets a new password after a rotation. If you ever create tables as a role other than `plainfeedback`, rerun the grants as that role.

### Logging

- Do not set `log_statement = all` or `mod`, and leave `log_parameter_max_length_on_error` at 0: either one puts submitted answers in the Postgres log. Defaults are fine.
- Keep the database off the public network (compose binds it to loopback).

## Backups

`compose.yaml` takes no backups. A backup is a full copy of every response, so:

```bash
# Nightly, from the host. Encrypt before the file leaves the machine.
docker compose exec -T db pg_dump -U plainfeedback -Fc plainfeedback \
  | age -r <recipient-public-key> > "/backups/plainfeedback-$(date +%F).dump.age"
find /backups -name 'plainfeedback-*.dump.age' -mtime +30 -delete   # backup retention
```

- Restrict who can read backups as tightly as the database.
- Backup retention must not exceed what the privacy statement says; deleting a response does not remove it from older backups until they expire.
- Test a restore once (`pg_restore -d <empty db>`).

## Retention and deletion

Deletion is real: there is no soft delete or undo, and the data stays in backups only until they rotate (see above). Nothing deletes on a schedule (automation is [#47](https://github.com/seandavi/plainfeedback/issues/47)), so keeping the retention period in the privacy statement is the group owner's and the operator's job. Export first if the summaries need recomputing. All of these are in the staff UI with a confirmation, and in the API (`/api/docs`):

- Owner: `DELETE /api/v1/events/{e}/surveys/{s}/responses?before=<ISO time>` deletes a survey's responses (all of them without `before`) and returns the count; `DELETE .../responses/{responseId}` deletes one (ids are in the export; in the staff UI, use Delete on a row of the survey's responses page).
- Owner: `DELETE /api/v1/events/{e}/surveys/{s}` deletes a survey with its versions and responses; a creator may delete a survey that was never published. `DELETE /api/v1/groups/{g}/events/{slug}` deletes an event with everything in it.
- Admin: `DELETE /api/v1/groups/{g}` deletes a group with everything in it, and only once it is archived.
- In an archived group, un-archive first; other deletes answer 409 there. Expired staff sessions are deleted at each staff login.

## Before real data

Work through the checklist at the end of [threat-model.md](threat-model.md#before-real-data). The independent review of auth and permission code ([#33](https://github.com/seandavi/plainfeedback/issues/33)) is done ([review](reviews/2026-10-14-phase-1.md)); its [deployment checklist](reviews/2026-10-14-phase-1.md#deployment-checklist) still applies.

## onclappc02 (reference deployment)

`plainfeedback.cancerdatasci.org` runs from a checkout of this repo on onclappc02 with
`COMPOSE_FILE=compose.yaml:deploy/onclappc02/compose.override.yaml` in `.env`. The override joins
the shared Traefik `proxy` network, uses Cloudflare's orange cloud (Traefik serves the CF Origin
Cert), and sets `observability.accessLogs=false` on the router so Traefik's access log (shipped to
ClickHouse with client IP and user agent) never records this app. Set `TRUST_PROXY=cf-connecting-ip`.
DNS and the uptime check are OpenTofu in `monode/infrastructure/terraform/apps/plainfeedback/`.
Cloudflare's edge still sees participant IPs; say so in the privacy statement.
