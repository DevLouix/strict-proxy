# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/controller/package.json apps/controller/package.json
COPY apps/node-agent/package.json apps/node-agent/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/gatekeeper/package.json packages/gatekeeper/package.json
RUN npm ci --ignore-scripts

COPY . .
RUN npm run typecheck

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY docker/controller-entrypoint.sh /usr/local/bin/controller-entrypoint
COPY docker/validate-controller-env.sh /usr/local/bin/validate-controller-env
RUN chmod 0755 /usr/local/bin/controller-entrypoint /usr/local/bin/validate-controller-env \
    && useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin strictproxy \
    && chown -R strictproxy:strictproxy /app

USER strictproxy
EXPOSE 8080
ENTRYPOINT ["controller-entrypoint"]
