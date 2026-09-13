# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app

ARG SING_BOX_VERSION=1.13.21
ARG TARGETARCH

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/controller/package.json apps/controller/package.json
COPY apps/node-agent/package.json apps/node-agent/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/gatekeeper/package.json packages/gatekeeper/package.json
RUN npm ci --ignore-scripts

COPY . .
RUN npm run typecheck

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SING_BOX_BINARY=/usr/local/bin/sing-box \
    SING_BOX_RESTART_MODE=managed \
    NODE_IDENTITY_PATH=/var/lib/strict-proxy/node-identity.json \
    SING_BOX_CONFIG_PATH=/etc/sing-box/config.json \
    SING_BOX_STATS_PROTO=/app/apps/node-agent/src/v2rayapi/stats.proto
ARG SING_BOX_VERSION=1.13.21
ARG TARGETARCH
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH}" in \
         amd64) SB_ARCH=amd64 ;; \
         arm64) SB_ARCH=arm64 ;; \
         *) echo "Unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && curl --fail --silent --show-error --location \
       "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-${SB_ARCH}.tar.gz" \
       | tar -xz --strip-components=1 -C /usr/local/bin \
    && test -x /usr/local/bin/sing-box \
    && /usr/local/bin/sing-box version

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY docker/node-agent-entrypoint.sh /usr/local/bin/node-agent-entrypoint
RUN mkdir -p /etc/sing-box /var/lib/strict-proxy \
    && chmod 0750 /etc/sing-box /var/lib/strict-proxy \
    && chmod 0755 /usr/local/bin/node-agent-entrypoint

EXPOSE 443/tcp 443/udp
ENTRYPOINT ["/usr/local/bin/node-agent-entrypoint"]
