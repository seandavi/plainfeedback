FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -C apps/web build
# Production dependencies of the server only (no drizzle-kit, vitest, biome, ...). --legacy because
# pnpm 10 otherwise needs inject-workspace-packages; @plainfeedback/core is copied in as a package.
RUN pnpm --filter @plainfeedback/server deploy --prod --legacy /out

# ponytail: the server still runs its TypeScript through tsx (a production dependency of
# apps/server), because @plainfeedback/core is shipped as .ts source ("main": "src/index.ts").
# Compile both packages to JS (and drop tsx) if start-up time or size ever matters.
FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/web
WORKDIR /app/server
COPY --from=build --chown=node:node /out /app/server
COPY --from=build --chown=node:node /app/apps/web/dist /app/web
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
