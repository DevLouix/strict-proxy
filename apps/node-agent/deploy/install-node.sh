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

# The tunnel port must be free: sing-box exits immediately when something else
# serves it, and every client then hangs on a port that accepts connections.
# 443 is preferred because it looks like ordinary HTTPS; the alternates are
# HTTPS-ish ports that are usually unused. A pinned NODE_TUNNEL_PORT is never
# overridden — an explicit choice that is broken should fail loudly.
port_is_free() {
  if ! command -v ss >/dev/null 2>&1; then
    return 0
  fi
  ! ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
}

if [ -n "${NODE_TUNNEL_PORT:-}" ]; then
  tunnel_port=$NODE_TUNNEL_PORT
  if ! port_is_free "$tunnel_port"; then
    echo "Port $tunnel_port is already in use on this host:" >&2
    ss -ltnp "sport = :$tunnel_port" 2>/dev/null >&2 || true
    echo "Stop that service, or omit NODE_TUNNEL_PORT and rerun to let the installer pick a free port." >&2
    exit 1
  fi
else
  tunnel_port=
  for candidate in 443 8443 2053 2083 2087 2096 8880 9443 10443; do
    if port_is_free "$candidate"; then
      tunnel_port=$candidate
      break
    fi
  done
  if [ -z "$tunnel_port" ]; then
    echo "Every preferred tunnel port is in use (443 8443 2053 2083 2087 2096 8880 9443 10443)." >&2
    echo "Free one of them, or rerun with NODE_TUNNEL_PORT=<free port>; it must be open for TCP and UDP inbound." >&2
    exit 1
  fi
  echo "NODE_TUNNEL_PORT was not set; picked free port $tunnel_port."
  if [ "$tunnel_port" != "443" ]; then
    echo "443 is taken on this host, so clients will be pointed at $tunnel_port instead." >&2
  fi
fi

apt-get update
apt-get install -y ca-certificates curl nodejs npm sing-box

# --- grant the node what it needs -------------------------------------------
# TUN device for the engine's own outbound sockets.
modprobe tun 2>/dev/null || true

# Forwarding lets the engine route client traffic out of the VPS.
if [ -d /etc/sysctl.d ]; then
  cat > /etc/sysctl.d/99-strict-proxy-node.conf <<'SYSCTL'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
SYSCTL
  sysctl --system >/dev/null 2>&1 || true
fi

# Open the tunnel port for both protocols. REALITY is TCP; usage accounting and
# future UDP flows need UDP, and a closed UDP port looks like a broken tunnel.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$tunnel_port"/tcp >/dev/null
  ufw allow "$tunnel_port"/udp >/dev/null
  echo "Opened $tunnel_port/tcp and $tunnel_port/udp in ufw."
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$tunnel_port"/tcp >/dev/null
  firewall-cmd --permanent --add-port="$tunnel_port"/udp >/dev/null
  firewall-cmd --reload >/dev/null
  echo "Opened $tunnel_port/tcp and $tunnel_port/udp in firewalld."
fi

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
echo "Verify the deployment with: sudo -u strictproxy env $(grep -v '^#' "$env_file" | xargs) npm run self-check -w apps/node-agent"
