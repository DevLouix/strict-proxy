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

# sing-box is compiled here rather than downloaded: the official release
# binaries are built without `with_v2ray_api` (the per-user stats this agent
# reads) and without `with_utls` (which the REALITY inbound requires), so a
# release tarball cannot load the configuration the agent renders.
FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS singbox
ARG SING_BOX_VERSION=1.14.4
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64|arm64) ;; \
      *) echo "Unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac
WORKDIR /src
RUN curl --fail --silent --show-error --location \
      "https://github.com/SagerNet/sing-box/archive/refs/tags/v${SING_BOX_VERSION}.tar.gz" \
      | tar -xz --strip-components=1
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" \
    go build -tags "with_v2ray_api,with_utls" -trimpath \
      -ldflags "-s -w -X github.com/sagernet/sing-box/constant.Version=${SING_BOX_VERSION}" \
      -o /out/sing-box ./cmd/sing-box

# Refuse to ship an engine that cannot load a REALITY inbound or expose the
# stats API: both are what the agent depends on at runtime.
RUN KEY="$(/out/sing-box generate reality-keypair | sed -n 's/^PrivateKey: //p')" \
    && printf '%s' "{\"inbounds\":[{\"type\":\"vless\",\"tag\":\"smoke\",\"listen\":\"127.0.0.1\",\"listen_port\":2443,\"users\":[{\"uuid\":\"8f0e2a4c-1111-4222-8333-944455556666\",\"flow\":\"xtls-rprx-vision\"}],\"tls\":{\"enabled\":true,\"server_name\":\"www.microsoft.com\",\"reality\":{\"enabled\":true,\"handshake\":{\"server\":\"www.microsoft.com\",\"server_port\":443},\"private_key\":\"${KEY}\",\"short_id\":[\"0123456789abcdef\"]}}}],\"outbounds\":[{\"type\":\"direct\"}],\"experimental\":{\"v2ray_api\":{\"listen\":\"127.0.0.1:10085\",\"stats\":{\"enabled\":true,\"users\":[\"smoke\"]}}}}" > /tmp/smoke.json \
    && /out/sing-box version \
    && /out/sing-box check -c /tmp/smoke.json

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SING_BOX_BINARY=/usr/local/bin/sing-box \
    SING_BOX_RESTART_MODE=managed \
    NODE_IDENTITY_PATH=/var/lib/strict-proxy/node-identity.json \
    SING_BOX_CONFIG_PATH=/etc/sing-box/config.json \
    SING_BOX_STATS_PROTO=/app/apps/node-agent/src/v2rayapi/stats.proto
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=singbox /out/sing-box /usr/local/bin/sing-box
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY docker/node-agent-entrypoint.sh /usr/local/bin/node-agent-entrypoint
RUN test -x /usr/local/bin/sing-box \
    && mkdir -p /etc/sing-box /var/lib/strict-proxy \
    && chmod 0750 /etc/sing-box /var/lib/strict-proxy \
    && chmod 0755 /usr/local/bin/node-agent-entrypoint

EXPOSE 443/tcp 443/udp
ENTRYPOINT ["/usr/local/bin/node-agent-entrypoint"]
