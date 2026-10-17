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

# factory job <n>: start its Postgres and install deps; prints the KEY=VALUE env every factory agent gets (safe to re-run)
factory-setup n:
    #!/usr/bin/env bash
    set -euo pipefail
    db=$((56000 + {{n}} % 1000))
    name=pf-factory-{{n}}
    if [ -z "$(docker ps -q -f name="^${name}$")" ]; then
      docker run -d --rm --name "$name" -e POSTGRES_USER=plainfeedback -e POSTGRES_PASSWORD=dev \
        -e POSTGRES_DB=plainfeedback -p 127.0.0.1:$db:5432 postgres:17-alpine >/dev/null
    fi
    # -h 127.0.0.1: the image's init-time server listens on the socket only, so this waits for the real one
    timeout 60 bash -c "until docker exec $name pg_isready -q -h 127.0.0.1 -U plainfeedback; do sleep 1; done"
    pnpm install --frozen-lockfile >&2
    echo "DATABASE_URL=postgresql://plainfeedback:dev@127.0.0.1:$db/plainfeedback"
    echo "PORT_BASE=$((4000 + {{n}} % 1000 * 10))"

# stop factory job <n>'s Postgres
factory-teardown n:
    -docker stop pf-factory-{{n}}
