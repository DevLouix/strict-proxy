#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLIENT_DIR="${ROOT_DIR}/apps/client"
AAR="${CLIENT_DIR}/packages/libbox_bridge/android/libs/libbox.aar"

if [[ ! -f "$AAR" ]]; then
  echo "libbox.aar is not present; Android compilation can still run, but VPN runtime tests are skipped." >&2
  exit 0
fi

echo "libbox.aar present: Android native runtime artifact is available."
