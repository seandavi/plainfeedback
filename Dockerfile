FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -C apps/web build

# ponytail: runtime reuses the build tree (incl. dev deps) and runs TS via tsx; slim with `pnpm deploy` if image size matters.
FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/apps/web/dist
WORKDIR /app/apps/server
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
