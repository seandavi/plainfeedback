# 0005. Pluggable OIDC for staff authentication

- Status: accepted
- Date: 2026-10-14

## Decision
Staff sign in through a provider interface over OIDC (Authlib). Google is the default for development; secrets come from GCP Secret Manager. Participants never authenticate.

## Consequences
Other providers (ORCID, institutional) can be added by config. The OAuth client needs this app's redirect URI registered.
