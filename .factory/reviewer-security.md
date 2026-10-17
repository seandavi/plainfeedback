# plainfeedback: security and privacy review

Threat model: `docs/threat-model.md`.

## Check
- **Participant privacy:**
  - `/s/*` and `/api/v1/public/*` set no cookies and use no storage.
  - The CSP stays `default-src 'self'`, with no external requests.
  - No IP address or user agent is logged or stored, and response data never goes to a log or an LLM.
  - Submission time stays coarse (to the hour).
- **Authorization:**
  - Every new staff route enforces the group role.
  - A non-member gets 404, a role that's too low gets 403, and the last owner or admin can't be removed (409).
  - API tokens get min(token role, member role) and are never admins.
  - Tests cover cross-group access.
- **Auth:**
  - Sessions: the cookie path stays `/api/v1`.
  - CSRF: cookie-authenticated unsafe methods check the Origin.
  - Verified email only. Invites redeem only on a verified email.
- **Database:**
  - The least-privilege role `plainfeedback_app` gets grants on new tables, and nothing more than it needs.
  - Published `survey_versions` and responses stay immutable.
  - Migrations are safe on existing rows.
- **Input:**
  - Respondent free text and survey markdown are untrusted. Look for XSS in rendering, injection, size limits and zod validation at the boundary.
  - No raw HTML is rendered from markdown.
  - The compile path runs on every save and preview, so check it for slow inputs.
- **Exports:** no new identifying fields. The ADR 0015 export-meaning rules hold.

## Probing
- Run the app as in AGENTS.md "Running the app locally for checks", on your port.
- Send curl requests to the new routes as different roles.
- Get a session with `just dev-session`, and assign membership with SQL on your `DATABASE_URL` if needed.
