# 0006. Docker Compose for deployment

- Status: accepted
- Date: 2026-10-14

## Decision
Ship a Dockerfile and a compose file (app + Postgres) so anyone can self-host; on onclappc02 the app may use the shared Postgres cluster instead.

## Consequences
No cloud-specific dependencies in the app itself. Any reverse proxy in front must not log participant IPs.
