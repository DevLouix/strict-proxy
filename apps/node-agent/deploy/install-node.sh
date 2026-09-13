#!/usr/bin/env bash
set -euo pipefail

# Install the node agent on a Debian/Ubuntu VPS.
# Usage:
#   sudo CONTROLLER_URL=https://controller.example.com \
#     NODE_ENROLLMENT_TOKEN=... NODE_PUBLIC_IP=203.0.113.10 \
#     NODE_HOSTNAME=fra-1 NODE_LABEL='Frankfurt 1' \
#     bash install-node.sh

: "${CONTROLLER_URL:?CONTROLLER_URL is required}"
: "${NODE_ENROLLMENT_TOKEN:?NODE_ENROLLMENT_TOKEN is required}"
: "${NODE_PUBLIC_IP:?NODE_PUBLIC_IP is required}"
: "${NODE_HOSTNAME:?NODE_HOSTNAME is required}"

apt-get update
apt-get install -y ca-certificates curl nodejs npm sing-box

install -d -m 0750 /opt/strict-proxy/node-agent /etc/strict-proxy
# The release/package deployment should place the compiled agent and proto here.
# This script intentionally does not download untrusted code from a floating URL.

env_file=/etc/strict-proxy/agent.env
cat > "$env_file" <<EOF
CONTROLLER_URL=$CONTROLLER_URL
NODE_ENROLLMENT_TOKEN=$NODE_ENROLLMENT_TOKEN
NODE_IDENTITY_PATH=/etc/strict-proxy/node-identity.json
NODE_PUBLIC_IP=$NODE_PUBLIC_IP
NODE_TUNNEL_PORT=${NODE_TUNNEL_PORT:-443}
NODE_HOSTNAME=$NODE_HOSTNAME
NODE_LABEL=${NODE_LABEL:-$NODE_HOSTNAME}
NODE_REALITY_SERVER_NAME=${NODE_REALITY_SERVER_NAME:-www.microsoft.com}
SING_BOX_BINARY=${SING_BOX_BINARY:-/usr/local/bin/sing-box}
SING_BOX_RESTART_MODE=${SING_BOX_RESTART_MODE:-systemd}
SING_BOX_CONFIG_PATH=${SING_BOX_CONFIG_PATH:-/etc/sing-box/config.json}
SING_BOX_STATS_API_LISTEN=${SING_BOX_STATS_API_LISTEN:-127.0.0.1:10085}
SING_BOX_STATS_PROTO=${SING_BOX_STATS_PROTO:-/opt/strict-proxy/node-agent/src/v2rayapi/stats.proto}
HEARTBEAT_INTERVAL_SECONDS=${HEARTBEAT_INTERVAL_SECONDS:-30}
SYNC_INTERVAL_SECONDS=${SYNC_INTERVAL_SECONDS:-60}
USAGE_INTERVAL_SECONDS=${USAGE_INTERVAL_SECONDS:-60}
LOG_LEVEL=${LOG_LEVEL:-info}
EOF
chmod 0600 "$env_file"

echo "Agent environment written to $env_file."
echo "Copy the built node-agent files and deploy/strict-proxy-agent.service, then enable it."
echo "The enrollment token is one-use and should be removed from $env_file after the first successful enrollment."
