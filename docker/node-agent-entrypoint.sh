#!/usr/bin/env sh
set -eu

if [ -z "${NODE_ENROLLMENT_TOKEN:-}" ] && [ ! -s "${NODE_IDENTITY_PATH:-/var/lib/strict-proxy/node-identity.json}" ]; then
  echo "NODE_ENROLLMENT_TOKEN is required on first node startup" >&2
  exit 1
fi

# NODE_PUBLIC_IP is optional: when it is empty the agent detects the node's
# public address (NODE_PUBLIC_IP_ECHO_URL) and reports it to the controller.
if [ "${NODE_PUBLIC_IP:-}" = "127.0.0.1" ]; then
  echo "NODE_PUBLIC_IP must be a public address, or empty to auto-detect it" >&2
  exit 1
fi

if [ "${NODE_HOSTNAME:-}" = "strict-proxy-node-agent" ] || [ -z "${NODE_HOSTNAME:-}" ]; then
  echo "NODE_HOSTNAME must be set to the node hostname" >&2
  exit 1
fi

exec node --import tsx apps/node-agent/src/agent.ts
