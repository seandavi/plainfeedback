set dotenv-load

# run server (watch) and web dev server; needs `just up db` and a .env
dev:
    pnpm -C apps/server dev & pnpm -C apps/web dev; kill %1

# DB tests default to the `just db-up` Postgres when DATABASE_URL is unset (no .env needed)
test:
    DATABASE_URL="${DATABASE_URL:-postgresql://plainfeedback:plainfeedback-dev-only@localhost:${DB_PORT:-5432}/plainfeedback}" pnpm test

# start local Postgres 17 only (DB_PORT=... if 5432 is taken); each DB test file makes and drops its own database
db-up:
    docker compose up --build -d --wait db

lint:
    pnpm lint

typecheck:
    pnpm typecheck

up *args:
    docker compose up --build -d --wait {{args}}

down:
    docker compose down

# apply pending DB migrations (needs DATABASE_URL); not run automatically on app start
migrate:
    pnpm -C apps/server migrate

# regenerate docs/openapi.json (commit it; a test fails on drift)
openapi:
    pnpm -C apps/server exec tsx src/openapi-gen.ts

# generate a migration after editing apps/server/src/schema
migration-generate name:
    pnpm -C apps/server exec drizzle-kit generate --name {{name}}
