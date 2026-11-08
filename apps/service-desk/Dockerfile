FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ENV NX_DAEMON=false
RUN pnpm exec nx build service-desk

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
WORKDIR /app
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build /app/dist/apps/service-desk ./dist/apps/service-desk
COPY --from=build /app/apps/service-desk/src/dal/migrations ./apps/service-desk/src/dal/migrations
COPY --from=build /app/config ./config
ENV NODE_ENV=production STATIC_DIR=/app/dist/apps/service-desk/ui/browser SETTINGS_FILE=/data/settings/backend.json
RUN mkdir -p /data/settings && chown node:node /data/settings
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "dist/apps/service-desk/api/main.cjs"]

FROM runtime AS migrate
CMD ["sh", "-c", "node dist/apps/service-desk/api/migrate.cjs && exec node dist/apps/service-desk/api/seed.cjs"]
