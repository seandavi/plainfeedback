# plainfeedback: what the approver escalates

These apply in addition to the generic rules in `factory-approver`.

1. **Database:** a migration, a schema change, `db/` init scripts or grants.
2. **Auth or access:** auth, sessions, CSRF, OIDC, RBAC or membership logic, or API tokens. Files include `auth.ts`, `authz.ts`, `tokens.ts` and the membership routes in `groups.ts`.
3. **Participant surface:** `public.ts`, `/s/*` rendering, CSP or security headers, cookies, logging, rate limiting, or `clientip.ts`.
4. **Deploy:** `justfile` recipes used in deploy.
5. **Decisions and docs:**
   - a new or superseding ADR;
   - a change to export meaning (ADR 0015);
   - edits to `docs/threat-model.md` or the privacy statement template.

Generated files, left out of the size count: `docs/openapi.json`.
