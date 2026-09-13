#!/usr/bin/env sh
set -eu

if [ -z "${NODE_ENROLLMENT_TOKEN:-}" ] && [ ! -s "${NODE_IDENTITY_PATH:-/var/lib/strict-proxy/node-identity.json}" ]; then
  echo "NODE_ENROLLMENT_TOKEN is required on first node startup" >&2
  exit 1
fi

if [ "${NODE_PUBLIC_IP:-}" = "127.0.0.1" ] || [ -z "${NODE_PUBLIC_IP:-}" ]; then
  echo "NODE_PUBLIC_IP must be set to the node's public address" >&2
  exit 1
fi

if [ "${NODE_HOSTNAME:-}" = "strict-proxy-node-agent" ] || [ -z "${NODE_HOSTNAME:-}" ]; then
  echo "NODE_HOSTNAME must be set to the node hostname" >&2
  exit 1
fi

exec node --import tsx apps/node-agent/src/agent.ts
