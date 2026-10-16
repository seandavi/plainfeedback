set dotenv-load

# run server (watch) and web dev server; needs `just up db` and a .env
dev:
    pnpm -C apps/server dev & pnpm -C apps/web dev; kill %1

test:
    pnpm test

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

# local checks: print a pf_session cookie for <email>, owner of group "Dev" (localhost DB only)
dev-session email *flags:
    pnpm -C apps/server exec tsx src/dev-session.ts {{email}} {{flags}}

# generate a migration after editing apps/server/src/schema
migration-generate name:
    pnpm -C apps/server exec drizzle-kit generate --name {{name}}
