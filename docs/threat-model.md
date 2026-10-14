# Threat model

What plainfeedback protects, from whom, how, and what it does not protect. Written for issue #12 against the code as of October 2026 (phase 1: groups, surveys, participant page, export, API tokens, staff shell and editor; no response viewer yet). File paths are the actual mitigations. "Residual" is what is left after them. Update this file when a mitigation or a residual risk changes.

This is a self-review. It does not replace the independent review of auth and permission code in [#33](https://github.com/seandavi/plainfeedback/issues/33), which must happen before real data (see the [checklist](#before-real-data)).

## Summary

The software avoids collecting participant identifiers: no accounts, no cookies, no storage, no IP or user agent in the database or the app's log. It does **not** make responses anonymous by itself:

- Anyone with the link can submit, as often as the rate limit allows ([#34](https://github.com/seandavi/plainfeedback/issues/34)).
- Free text and small groups can identify people. Submission times are kept to the hour only ([#37](https://github.com/seandavi/plainfeedback/issues/37)).
- The reverse proxy, CDN, host and network see participant IPs unless the deployer configures them not to log ([deploy.md](deploy.md)).
- Group viewers, global admins and whoever runs the database can read every response.

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| Responses (choice, Likert, number) | `responses.answers` (jsonb), exports | Demographic choices plus a small group can identify a person. |
| Free-text answers | same | Untrusted input; often contains names, roles, institutions, opinions about named people. |
| `submitted_at`, `seq` | `responses.submitted_at` truncated to the hour (CHECK constraint); `responses.seq` a global counter; both exported | Time joins with other timed records (proxy log, sign-in sheet); `seq` gives order within the hour. |
| Survey drafts and versions | `surveys`, `survey_versions` | Mostly not sensitive; unpublished drafts are internal. Privacy statement shown to participants. |
| Staff accounts | `users` (email, issuer, subject, `is_admin`), `memberships` | Control over who reads responses. |
| Staff sessions | `pf_session` cookie; `sessions.id_hash` (SHA-256 only) | Session theft = staff access. |
| API tokens | `pf_...` plaintext held by the user; `api_tokens.token_hash` (SHA-256 only) | Long-lived (up to 365 days) group access. |
| OIDC client secret | env / GCP Secret Manager ([deploy-auth.md](deploy-auth.md)) | Lets someone impersonate the app to the IdP. |
| Public survey id | `surveys.public_id`, 60 random bits, in the link and QR code | Knowing it is the only thing needed to submit. Not a secret once shared. |
| Backups and logs | outside the app | Copies of all of the above, often kept longer and with weaker access control. |

## Actors

| Actor | Can | Wants / risk |
|---|---|---|
| Anonymous participant | Open `/s/{publicId}`, submit. | Should not be identifiable beyond what they type. |
| Spammer / ballot stuffer | Has (or guesses nothing; needs) the shared link; scripts the POST. | Skew results, fill storage, lock out real participants. |
| Curious viewer | Legitimate group `viewer`; reads and exports responses. | Work out who wrote what. |
| Malicious group member | `creator` or `owner` in group A. | Read or change group B; raise own role; publish a misleading privacy statement in their own group. |
| Holder of a compromised token or session | Stolen `pf_...` token or `pf_session` cookie. | Act as that staff user. |
| Operator / host | Shell, DB, backups, proxy logs. | Can read everything. Trusted by design; must be bound by policy, not code. |
| Network / CDN / reverse proxy | Sees TLS-terminated traffic (CDN) or connection metadata (network). | IP + time + path logs; a CDN sees request bodies including free text. |
| LLM provider (phase 2) | Receives prompts from the chat assistant. | Must never receive responses. |

## Trust boundaries

```
participant browser ──TLS──> [CDN, e.g. Cloudflare] ──> reverse proxy (TLS, logs) ──> app :3000 ──> Postgres
                                                                                         │
staff browser / CI ───TLS──> same path, cookie or Bearer token ──────────────────────────┘
                                                                                app ──> OIDC issuer (login only)
```

1. **Internet to proxy/CDN.** Everything before the app is outside its control. IP logging, TLS, bot cookies and edge analytics are the deployer's configuration.
2. **Proxy to app.** The app reads no client IP header (`X-Forwarded-For` is never read; `apps/server/src/app.ts`), so it cannot log one. `compose.yaml` binds the app to `127.0.0.1` by default so traffic must pass the proxy.
3. **Participant routes vs staff routes.** `/s/*` and `/api/v1/public/*` (`isParticipantPath`, `apps/server/src/app.ts`) never read a session, never set a cookie, carry a strict CSP. All other responses (staff SPA, API docs, JSON, exports) carry a staff CSP and every response sends `X-Frame-Options: DENY` with `frame-ancestors 'none'`. Everything else under `/api/v1` needs a session or token.
4. **Group boundary.** Every staff resource resolves to a group in one function (`authorize`, `apps/server/src/authz.ts`, [ADR 0009](adr/0009-group-rbac-404.md)).
5. **App to IdP.** Only at login (`apps/server/src/auth.ts`).
6. **App to LLM (phase 2).** Drafts and source documents only, never responses (AGENTS.md invariant).

## Threats (STRIDE)

S = spoofing, T = tampering, R = repudiation, I = information disclosure, D = denial of service, E = elevation of privilege.

| # | Threat | STRIDE | Mitigation in code | Residual risk |
|---|---|---|---|---|
| 1 | **Ballot stuffing via the shared link.** Anyone with the link submits many times. | T | Strict server-side validation of every answer against the version's model, unknown keys rejected (`validateAnswers`, `packages/core/src/answers.ts`); JSON only, 64 KB body limit (`jsonOnly`, `bodyLimit`, `apps/server/src/public.ts`); per-survey token bucket, burst 200 then 5/s (`DEFAULT_RATE`, `public.ts`). | **High.** No client identity by design ([ADR 0004](adr/0004-anonymous-link-only-v1.md)), so duplicates cannot be told apart. ~430k responses/day per survey are possible. No response cap ([#34](https://github.com/seandavi/plainfeedback/issues/34)). Owners can delete spam by response id or by time ([#36](https://github.com/seandavi/plainfeedback/issues/36)). Analysts should look for bursts in `submittedAt` and `seq`. |
| 2 | **Lock-out**: an abuser keeps the per-survey bucket empty so real participants get 429. | D | None beyond the bucket refilling at 5/s. | **Medium.** One script can block a survey during an event ([#34](https://github.com/seandavi/plainfeedback/issues/34)). Proxy-level per-IP limiting (in memory, not logged) helps; see [deploy.md](deploy.md). |
| 3 | **Guessing survey ids** to find unpublished or other surveys. | I | 60-bit random `public_id` (`apps/server/src/publicid.ts`, [ADR 0011](adr/0011-participant-page.md)); 404 until published; the id is not derived from slugs. | Low. A leaked link can only be stopped by closing the survey; there is no "rotate id" yet. |
| 4 | **Storage / CPU exhaustion** on public endpoints. | D | Body limit, rate limit, bucket map keyed only after lookup so unknown ids cannot grow it (`public.ts`); GET is a single indexed query. | Medium. GET is not rate limited; rate limit is per process. Put a proxy limit in front. |
| 5 | **Re-identification from small cells** (e.g. the only NIH representative at the meeting). | I | None in code yet: no aggregates exist. Any future aggregate view must suppress cells with fewer than 5 responses (threshold configurable), including cells recoverable by subtraction from totals ([design.md](design.md), [#46](https://github.com/seandavi/plainfeedback/issues/46)). | **High** for small events. Viewers export row-level data. Survey authors should avoid fine-grained demographics ([privacy template](privacy-statement-template.md)). |
| 6 | **Re-identification from free text.** | I | Codebook and CSV column metadata flag `freeText` (`columnsFor`, `apps/server/src/responses.ts`); default privacy statement warns participants (`DEFAULT_PRIVACY_STATEMENT`, `apps/server/src/surveys.ts`). | **High.** Nothing can stop someone writing their name. Viewers must treat free text as identifying. |
| 7 | **Re-identification from timestamps** joined with attendance lists, door kiosks, or proxy/CDN logs (IP + time of the POST). | I | The app stores no IP or UA and logs no timestamp-plus-identifier itself (`accessLog`, `app.ts`). `submitted_at` is stored and exported to the hour only: a column default plus a CHECK constraint (migration 0007, [#37](https://github.com/seandavi/plainfeedback/issues/37), [ADR 0012](adr/0012-deletion-and-coarse-time.md)). | **Medium.** Within an hour, `seq` still gives exact order, so a viewer who knows when one person submitted relative to others can narrow it down. `seq` is global, so its gaps also hint at how many responses other surveys (other groups) got in between. Any proxy/CDN log of `POST /api/v1/public/.../responses` with an IP links an IP to a response by time; [deploy.md](deploy.md) says how to stop that. |
| 8 | **Cross-group access**: a member of group A reads or writes group B, by id guessing or by mixing ids in a path. | E, I | One check, `authorize`/`resolveGroup` (`apps/server/src/authz.ts`), resolves group, event or survey to its group and joins membership; route middleware `requireGroupRole`/`requireEventRole`; 404 for non-members, malformed ids and missing resources alike; survey lookups are scoped to the authorized event id (`loadSurvey`, `surveys.ts`; `versionsOf`, `responses.ts`). Tests: `groups.test.ts`, `surveys.test.ts`, `responses.test.ts`, `tokens.test.ts`. | Low, pending the independent review ([#33](https://github.com/seandavi/plainfeedback/issues/33)). Every new route must use the middleware; nothing enforces that mechanically. |
| 9 | **Role escalation inside a group** (creator makes self owner; owner makes self admin; last owner removed). | E | Membership changes are owner-only and session-only; admin flag is admin-only; last-owner and last-admin rules in a locking transaction (`groups.ts`, ADR 0009). | Low. Admins can do everything everywhere; there is no audit log of who changed what (R). |
| 10 | **CSRF** against cookie-authenticated staff routes. | T | Unsafe methods with a session need `Origin` equal to the origin of `OIDC_REDIRECT_URI`, missing `Origin` rejected (`sessionAuth`, `auth.ts`); `SameSite=Lax`; logout is POST; participant POST reads no cookie and is JSON-only (`jsonOnly`, `public.ts`), and the participant page fetches with `credentials: "omit"` (`apps/web/src/ParticipantPage.tsx`). | Low. GET routes must stay side-effect free (they are today). |
| 11 | **Login CSRF / OIDC flow tampering** (code injection, replay, mix-up). | S | Authorization code + PKCE (S256) + state + nonce via `openid-client`, transaction cookie `pf_oidc` scoped to `/api/v1/auth`, 10 min, cleared on callback; callback URL built from the configured redirect URI, not the request; fixed post-login redirect `/app` (no open redirect) (`authRoutes`, `auth.ts`). Tests with a fake IdP (`auth.test.ts`). | Low. |
| 12 | **OIDC misconfiguration**: wrong issuer, permissive domain allow-list, consumer Google accounts on an org domain, `ADMIN_EMAILS` left set. | S, E | Verified email required; exact domain match on `ALLOWED_EMAIL_DOMAINS`; users keyed by (issuer, subject); `ADMIN_EMAILS` promotes only (`auth.ts`); auth is disabled, not open, when unconfigured (`index.ts`). | **Medium.** Domain check uses the `email` claim, not Google's `hd`; a personal Google account created on `you@org.edu` passes ([#35](https://github.com/seandavi/plainfeedback/issues/35)). `ADMIN_EMAILS` promotes on every login. Changing `OIDC_ISSUER` changes whose `email_verified` you trust. |
| 13 | **Session theft** (XSS, network, logs, shared machine). | S | 256-bit random id; only its SHA-256 stored; cookie `HttpOnly; Secure; SameSite=Lax; Path=/api/v1`, never sent to `/s/*` (`auth.ts`, ADR 0005); 12 h TTL; logout deletes the row; access log has no headers or query (`accessLog`, `app.ts`). | Medium. `COOKIE_SECURE=false` exists for localhost and must never be set in production. No idle timeout; IdP disablement does not end sessions ([#38](https://github.com/seandavi/plainfeedback/issues/38)). |
| 14 | **API token leakage** (CI logs, committed `.env`, shell history). | S, I | `pf_` prefix (scannable by secret scanners); 256-bit; only the hash stored; shown once; group-scoped; role at most creator and capped by the user's current membership; never admin; never manages tokens or memberships; expiry required, max 365 days; owners can revoke; revocation is immediate (`auth.ts` `bearerUser`, `tokens.ts`, ADR 0010). | Medium. A leaked creator token can publish surveys (including a misleading privacy statement) and export all responses of its group until revoked or expired. `last_used_at` is hourly, so detection is coarse. |
| 15 | **XSS via markdown** in titles, intros, prompts, options or the privacy statement (author-controlled) on the participant page or the editor preview. | T, I | Hand-rolled renderer builds React elements, never HTML strings; raw HTML is shown as text; links only `http(s):`/`mailto:`, `rel="noopener noreferrer nofollow"`; images become alt text (`apps/web/src/markdown.tsx`, ADR 0011). Participant responses carry `Content-Security-Policy: default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` (`participantGuard`, `app.ts`). | Low on the participant page. The web bundle runs zod in `jitless` mode (`apps/web/src/zod-jitless.ts`) so the page needs no `unsafe-eval`; a test builds the app and asserts no inline script ([#40](https://github.com/seandavi/plainfeedback/issues/40)). A creator can still put a phishing link in a prompt; it opens in a new tab. |
| 16 | **XSS via respondent free text** in a staff viewer or export. | T, I, E | Exports are served as `application/x-ndjson` / `text/csv` with `X-Content-Type-Options: nosniff` on every response (`participantGuard`, `app.ts`), so a browser will not render them as HTML. React escapes text by default. Staff pages, the SPA fallback and the API docs get `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` (`STAFF_CSP`, `app.ts`, tested): no inline or eval scripts, so injected markup cannot run. `'unsafe-inline'` is for styles only, because CodeMirror injects `<style>` tags and Swagger UI sets style attributes. `apps/web/src/csp.test.ts` fails if `dangerouslySetInnerHTML` appears or `Markdown` is imported outside author-content views. | **Low, future-proofed.** There is no staff response viewer yet ([#39](https://github.com/seandavi/plainfeedback/issues/39)). Respondent text must still be rendered as plain text, never through `Markdown` or `dangerouslySetInnerHTML`; the test only guards the import list, not new views that are allow-listed. Style injection remains possible under `style-src 'unsafe-inline'` (CSS exfiltration of attribute values). |
| 17 | **CSV formula injection**: a respondent types `=HYPERLINK(...)` and a viewer opens the CSV in Excel. | T | String cells starting with `= + - @`, tab or CR get a leading `'` (`csvCell`, `responses.ts`); numbers untouched; tests in `responses.test.ts`. | Low. JSONL is not escaped (it is data, not a spreadsheet). Other tools that turn JSONL into spreadsheets must do their own escaping. Cells that begin with whitespace and then `=` are not prefixed. |
| 18 | **Log leakage**: answers, tokens, cookies, IPs or claims in logs. | I | Access log is `{method, path, status}` only, no query, headers, IP or UA (`accessLog`, `app.ts`, tested in `app.test.ts`). Unhandled errors log only the error class and SQLSTATE, because a failed query's message contains its parameters (e.g. answers) (`app.onError`, `app.ts`, tested). OIDC errors deliberately not logged (`auth.ts`). Strings with U+0000, which jsonb cannot store, are rejected as invalid answers instead of failing the insert (`answers.ts`). | Low in the app. The path is logged, so `/s/{publicId}` reveals which survey was opened and when (no identity). Postgres logs a failing statement's text by default, with `$1` placeholders but not values (`log_parameter_max_length_on_error` defaults to 0). Turning on `log_statement = all`/`mod`, or raising that setting, puts answers in the Postgres log ([deploy.md](deploy.md#postgres)). |
| 19 | **Reverse proxy / CDN logs IPs and user agents** for participant requests, and the `Referer` of asset requests names the survey. | I | App sets `Referrer-Policy: no-referrer` on participant pages so `/assets/*` requests do not carry `/s/{publicId}` (`participantGuard`, `app.ts`). Everything else is deployment config: [deploy.md](deploy.md) gives Caddy, nginx and Traefik settings. | **High until the deployer acts.** The default config of every common proxy logs client IP, time, path and UA. On the onclappc02 host, Traefik's access log keeps IP, UA and `Cf-Connecting-Ip` and ships them to ClickHouse for 90 days unless the router disables access logs. |
| 20 | **Cloudflare (or any TLS-terminating CDN)** sees decrypted traffic, including free-text bodies, and may set cookies or inject scripts. | I | CSP on participant pages blocks injected third-party scripts (Rocket Loader, Web Analytics beacons, Zaraz) from running. | **Medium.** Cloudflare sees IPs and request bodies and keeps its own logs and analytics; the app cannot change that. Bot Fight Mode sets `__cf_bm` and JavaScript detections/challenges set `cf_clearance`, which breaks "no cookies" unless turned off for the zone (Bot Fight Mode cannot be bypassed per path). Must be disclosed in the privacy statement if used. See [deploy.md](deploy.md#cloudflare). |
| 21 | **Backups** keep responses after deletion and are often less protected. | I | None in the app; `compose.yaml` has no backup job. | Medium. Deletion in the app is real, but backups keep deleted data until they rotate. Deployers must encrypt backups, restrict access and keep them no longer than the retention period ([deploy.md](deploy.md#backups)). |
| 22 | **Retention / deletion**: data kept forever; no way to honour a retention promise or remove spam. | I | Hard deletes ([#36](https://github.com/seandavi/plainfeedback/issues/36), [ADR 0012](adr/0012-deletion-and-coarse-time.md)): owners delete a response by id, a survey's responses (optionally before a time), a survey or an event; creators delete never-published surveys; admins delete archived groups. Cascades remove versions and responses; the version immutability trigger allows a delete only by that cascade. Expired sessions are deleted only when presented. | **Medium.** Nothing deletes on a schedule: keeping the retention promise is the owner's and operator's job ([deploy.md](deploy.md#retention-and-deletion), automation is [#47](https://github.com/seandavi/plainfeedback/issues/47)). Backups keep data until rotated. |
| 23 | **Operator / host reads everything.** | I | None in code (no encryption at rest beyond the host's disk). | Accepted. Disclose who runs the service in the privacy statement. Restrict DB and shell access. |
| 24 | **Misleading privacy statement** published by a creator. | R, I | Statement is stored immutably with each version (`survey_versions.privacy_statement`), so what participants saw is recorded. Default text only claims what the software does (`DEFAULT_PRIVACY_STATEMENT`). | Low-medium. The app cannot check that an author's statement is true. |
| 25 | **No audit trail** for staff actions (who exported, who changed roles). | R | None. The access log records method, path, status without user. | Medium for accountability; deliberate for privacy of participants. Revisit with [#33](https://github.com/seandavi/plainfeedback/issues/33). |
| 26 | **Clickjacking** of the participant page or staff UI. | T | `frame-ancestors 'none'` on participant paths (`participantGuard`). | Staff UI has none yet ([#39](https://github.com/seandavi/plainfeedback/issues/39)). |
| 27 | **LLM exposure (phase 2)**: responses or free text sent to a model provider; prompt injection from uploaded documents. | I, T | Not built. Invariant in AGENTS.md: response data never goes to an LLM or a log; chat sees drafts and source documents only and edits markdown, never JSON (design.md). | To be designed in phase 2 (#13): name the model provider in the privacy statement; treat uploaded documents as untrusted (they can carry instructions); keep the assistant's credentials unable to read responses (no export scope). |
| 28 | **Plain HTTP / TLS stripping.** | I, S | `Secure` cookies by default; `PUBLIC_BASE_URL` and `OIDC_REDIRECT_URI` are configured as `https://` in production. | The app does not terminate TLS or send HSTS; the proxy must ([deploy.md](deploy.md)). |

## What the software does not claim

- It does not prevent one person from answering many times.
- It does not make free text or small-group answers anonymous.
- It does not control logs kept by proxies, CDNs, hosting providers, networks or the participant's own device or employer network.
- It does not delete anything on a schedule. Owners and operators delete when the retention period ends ([#47](https://github.com/seandavi/plainfeedback/issues/47)).
- It has not yet had an independent security review.

## Before real data

Checklist for the first deployment that collects real responses. Owners: the deployer and the maintainers.

- [ ] Independent second review of auth and permission code ([#33](https://github.com/seandavi/plainfeedback/issues/33)). **Required.**
- [ ] Reverse proxy does not log IPs or user agents for this site (at least `/s/`, `/api/v1/public/` and `/assets/`), or anonymizes them; error log level checked ([deploy.md](deploy.md)).
- [ ] If behind Cloudflare: Bot Fight Mode, Web Analytics, Rocket Loader, Zaraz and Email Obfuscation off for the zone, and Cloudflare named in the privacy statement.
- [ ] TLS on, HSTS on, `COOKIE_SECURE` unset or `true`, `PUBLIC_BASE_URL` and `OIDC_REDIRECT_URI` on `https://`.
- [ ] `ALLOWED_EMAIL_DOMAINS` set; `ADMIN_EMAILS` emptied after the first admin exists ([#35](https://github.com/seandavi/plainfeedback/issues/35)).
- [ ] Backups encrypted, access-restricted, with a stated retention.
- [ ] A retention period decided and written in the privacy statement, and someone named to delete on that date ([deploy.md](deploy.md#retention-and-deletion)).
- [ ] Each survey's privacy statement adapted from [the template](privacy-statement-template.md).
- [ ] Rate-limit and spam plan for public links ([#34](https://github.com/seandavi/plainfeedback/issues/34)).
