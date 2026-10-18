# syntax=docker/dockerfile:1
# Deploy Window container image. No secrets in the image: tokens come from the environment,
# the configuration is mounted at /etc/deploy-window/config.yaml (DWA-CFG-001, DWA-DEP-003).

ARG NODE_VERSION=22
ARG PNPM_VERSION=12.14.0

FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:${NODE_VERSION}-slim
LABEL org.opencontainers.image.source="https://github.com/eins78/deploy-window" \
      org.opencontainers.image.description="Slack slash command that opens deploy windows by silencing Grafana alerts" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    DWA_HEALTH_FILE=/tmp/deploy-window.alive
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE NOTICE ./
USER node
# DWA listens on no port. The health check reads the age of the file that DWA writes while a
# Slack connection is up (DWA-OPS-007).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const f=process.env.DWA_HEALTH_FILE;process.exit(Date.now()-require('fs').statSync(f).mtimeMs<60000?0:1)"]
# Exec form keeps node as PID 1, so SIGHUP (reload) and SIGTERM (drain) reach it directly.
ENTRYPOINT ["node", "dist/main.js"]
CMD ["run"]
