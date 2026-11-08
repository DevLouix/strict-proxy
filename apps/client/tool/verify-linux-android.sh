#!/usr/bin/env bash
set -euo pipefail

CLIENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v flutter >/dev/null || { echo 'Flutter is required' >&2; exit 1; }

cd "$CLIENT_DIR"
flutter create --platforms=linux,android .
./tool/configure-android-host.sh
flutter pub get
flutter test
flutter analyze
flutter build linux --release \
  --dart-define=STRICT_ENV="${STRICT_ENV:-development}" \
  --dart-define=STRICT_CONTROLLER_URL="${STRICT_CONTROLLER_URL:-http://10.0.2.2:8080}" \
  --dart-define=STRICT_REQUEST_TIMEOUT_SECONDS="${STRICT_REQUEST_TIMEOUT_SECONDS:-15}"
flutter build apk --debug \
  --dart-define=STRICT_ENV="${STRICT_ENV:-development}" \
  --dart-define=STRICT_CONTROLLER_URL="${STRICT_CONTROLLER_URL:-http://10.0.2.2:8080}" \
  --dart-define=STRICT_REQUEST_TIMEOUT_SECONDS="${STRICT_REQUEST_TIMEOUT_SECONDS:-15}"

echo "Client tests passed and Linux/Android builds completed."
