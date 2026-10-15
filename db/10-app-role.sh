#!/bin/sh
# Creates (or re-passwords) the app's login role, plainfeedback_app (#76). Run by the postgres
# image on first init; for an existing database see docs/deploy.md#database-roles.
psql -v ON_ERROR_STOP=1 -v pw="${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT 'CREATE ROLE plainfeedback_app' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'plainfeedback_app') \gexec
ALTER ROLE plainfeedback_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
SQL
