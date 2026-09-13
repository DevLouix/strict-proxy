#!/usr/bin/env sh
set -eu

case "${TLS_MODE:-disabled}" in
  disabled)
    export CADDY_SITE_ADDRESS="http://${CADDY_SITE_ADDRESS#http://}"
    ;;
  managed)
    case "${CADDY_SITE_ADDRESS:-}" in
      https://*) : ;;
      *) echo "CADDY_SITE_ADDRESS must use https:// when TLS_MODE=managed" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "TLS_MODE must be disabled or managed" >&2
    exit 1
    ;;
esac

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
