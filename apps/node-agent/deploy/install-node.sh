#!/usr/bin/env bash
set -euo pipefail

# Install the node agent on a Debian/Ubuntu VPS.
# Usage:
#   sudo CONTROLLER_URL=https://controller.example.com \
#     NODE_ENROLLMENT_TOKEN=... \
#     NODE_HOSTNAME=fra-1 NODE_LABEL='Frankfurt 1' \
#     bash install-node.sh
#
# NODE_PUBLIC_IP is optional: when it is unset the agent detects the VPS's own
# public address and the controller records it automatically.
#
# NODE_DNS_SERVERS (default "1.1.1.1 8.8.8.8") is only used to repair a VPS
# whose system resolver cannot answer for the controller hostname.

: "${CONTROLLER_URL:?CONTROLLER_URL is required}"
: "${NODE_ENROLLMENT_TOKEN:?NODE_ENROLLMENT_TOKEN is required}"
: "${NODE_HOSTNAME:?NODE_HOSTNAME is required}"

# --- network preflight ------------------------------------------------------
# Some VPS images ship a resolver that cannot answer for the controller (or
# cannot answer at all). That makes apt-get and enrollment fail with an
# unhelpful "Temporary failure resolving". Repair it once, keeping a backup, so
# the rest of this script has working DNS. The agent itself uses the system
# resolver, so this also fixes the steady-state path.
controller_host=${CONTROLLER_URL#*://}
controller_host=${controller_host%%/*}
controller_host=${controller_host%%:*}

resolv_conf=/etc/resolv.conf
resolv_backup=${resolv_conf}.strict-proxy.bak

if ! getent hosts "$controller_host" >/dev/null 2>&1; then
  echo "Cannot resolve $controller_host with the system resolver; switching to ${NODE_DNS_SERVERS:-1.1.1.1 8.8.8.8}." >&2
  if [ -f "$resolv_conf" ] && [ ! -f "$resolv_backup" ]; then
    cp -a "$resolv_conf" "$resolv_backup"
  fi
  rm -f "$resolv_conf"
  for ns in ${NODE_DNS_SERVERS:-1.1.1.1 8.8.8.8}; do
    echo "nameserver $ns" >> "$resolv_conf"
  done
  if ! getent hosts "$controller_host" >/dev/null 2>&1; then
    echo "Still cannot resolve $controller_host after switching nameservers." >&2
    echo "Confirm the DNS record exists and that outbound DNS (UDP/TCP 53) is allowed, then rerun." >&2
    echo "The previous resolver configuration is at $resolv_backup." >&2
    exit 1
  fi
fi

# A node on port 443 needs that port to itself. When the controller or its
# reverse proxy shares the host, Dokploy/Traefik already owns 443, so fail with
# the fix instead of letting sing-box start and immediately die.
tunnel_port=${NODE_TUNNEL_PORT:-443}
if [ "$tunnel_port" = "443" ] && command -v ss >/dev/null 2>&1; then
  if ss -ltn 'sport = :443' 2>/dev/null | grep -q LISTEN; then
    echo "Port 443 is already in use on this host." >&2
    echo "If the controller or a proxy shares this host, rerun with NODE_TUNNEL_PORT=8443 and open 8443/tcp and 8443/udp." >&2
    exit 1
  fi
fi

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
# Optional. Leave unset to auto-detect the VPS's public IP.
NODE_PUBLIC_IP=${NODE_PUBLIC_IP:-}
NODE_PUBLIC_IP_ECHO_URL=${NODE_PUBLIC_IP_ECHO_URL:-https://api.ipify.org}
NODE_TUNNEL_PORT=$tunnel_port
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
