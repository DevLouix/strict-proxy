#!/usr/bin/env bash
#
# Confirm an exit node enrolled and is reporting itself to the controller.
#
# The controller publishes a signed fleet list at
# /api/v1/network/nodes/public-ips; a node appears there after its first
# successful enrollment and stays while its heartbeats arrive. Polling that list
# answers "did the node I just deployed actually come online?" without opening
# the admin panel.
#
# Environment:
#   BASE_URL    controller public URL, e.g. https://api.example.com  (required)
#   EXPECT_IP   public IPv4 of the node you deployed                 (optional;
#               without it, any non-empty fleet counts as success)
#   TIMEOUT     seconds to wait for the node                          (default 180)
#   INTERVAL    seconds between polls                                 (default 10)
#
# Exit status: 0 the node is in the fleet, 1 it never appeared, 2 usage error.
#
# Example, right after deploying the node service:
#   BASE_URL=https://api.example.com EXPECT_IP=203.0.113.10 \
#     ./scripts/verify-node-enrollment.sh
set -euo pipefail

BASE_URL="${BASE_URL:-}"
EXPECT_IP="${EXPECT_IP:-}"
TIMEOUT="${TIMEOUT:-180}"
INTERVAL="${INTERVAL:-10}"

if [[ -z "$BASE_URL" ]]; then
  echo "usage: BASE_URL=https://api.example.com [EXPECT_IP=<node public ip>] [TIMEOUT=180] $0" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"
command -v curl >/dev/null || { echo 'curl is required' >&2; exit 2; }
command -v node >/dev/null || { echo 'node is required (JSON parsing)' >&2; exit 2; }

fleet_url="$BASE_URL/api/v1/network/nodes/public-ips"
deadline=$((SECONDS + TIMEOUT))
attempt=0

while :; do
  attempt=$((attempt + 1))
  body="$(curl -fsS -m 15 "$fleet_url" 2>/dev/null || true)"

  if [[ -z "$body" ]]; then
    echo "attempt $attempt: no response from $fleet_url"
  else
    parsed="$(printf '%s' "$body" | node -e '
      let raw = "";
      process.stdin.on("data", (d) => (raw += d)).on("end", () => {
        let doc;
        try {
          doc = JSON.parse(raw);
        } catch {
          process.stdout.write("invalid-json\t-\t-\t-");
          return;
        }
        const ips = (doc.ips || []).map((entry) =>
          typeof entry === "string" ? entry : entry.ip || entry.publicIp || JSON.stringify(entry),
        );
        process.stdout.write(
          [ips.length, doc.keyId || "?", ips.join(",") || "-", doc.expiresAt || "?"].join("\t"),
        );
      });
    ')"
    IFS=$'\t' read -r count keyid ips expires <<<"$parsed"

    if [[ "$count" == "invalid-json" ]]; then
      echo "attempt $attempt: controller answered with something that is not a fleet list: $body" >&2
    elif [[ "$count" -eq 0 ]]; then
      echo "attempt $attempt: fleet is empty (keyId $keyid) — the node has not enrolled yet"
    else
      echo "attempt $attempt: fleet has $count node(s): $ips (keyId $keyid, expires $expires)"
      if [[ -z "$EXPECT_IP" ]]; then
        echo "enrolled: $count node(s) online"
        exit 0
      fi
      if printf '%s' ",$ips," | grep -Fq ",$EXPECT_IP,"; then
        echo "enrolled: $EXPECT_IP is online"
        exit 0
      fi
      echo "  waiting for $EXPECT_IP to appear"
    fi
  fi

  if ((SECONDS >= deadline)); then
    if [[ -n "$EXPECT_IP" ]]; then
      echo "error: $EXPECT_IP did not appear in the fleet within ${TIMEOUT}s" >&2
    else
      echo "error: no node appeared in the fleet within ${TIMEOUT}s" >&2
    fi
    echo 'Check the node service logs: a wrong NODE_CONTROLLER_URL, an expired' >&2
    echo 'enrollment token, or blocked outbound HTTPS all look like this.' >&2
    exit 1
  fi
  sleep "$INTERVAL"
done
