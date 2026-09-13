#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-${ROOT_DIR}/.env.docker}"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.production.yml"

command -v docker >/dev/null || { echo 'Docker Engine is required.' >&2; exit 1; }
docker compose version >/dev/null || { echo 'Docker Compose v2 plugin is required.' >&2; exit 1; }

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Environment file not found: $ENV_FILE" >&2
  echo "Copy .env.docker.example to .env.docker and replace every placeholder." >&2
  exit 1
fi

# Compose interpolation validates required settings and the complete merged
# deployment graph without starting any containers.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null

TLS_MODE="$(grep -E '^TLS_MODE=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
SITE="$(grep -E '^CADDY_SITE_ADDRESS=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
if [[ "$TLS_MODE" == managed && "$SITE" != https://* ]]; then
  echo 'TLS_MODE=managed requires CADDY_SITE_ADDRESS=https://...' >&2
  exit 1
fi

if grep -Eq '^NODE_ENROLLMENT_TOKEN=.+$' "$ENV_FILE" && [[ ! -e /dev/net/tun ]]; then
  echo 'Node deployment requires /dev/net/tun on the Linux host.' >&2
  exit 1
fi

printf '%s\n' "server prerequisites and Compose configuration passed: $ENV_FILE"
