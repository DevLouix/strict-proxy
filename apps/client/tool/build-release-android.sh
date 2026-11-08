#!/usr/bin/env bash
#
# Build a production Android client you can hand to users.
#
# This is deliberately stricter than `flutter build apk --release`:
#   - STRICT_ENV=production, so an unsigned config bundle is refused;
#   - the controller URL must be HTTPS;
#   - the controller's Ed25519 public key is baked in;
#   - libbox.aar must be built and present, because an APK without it cannot
#     open a VPN session;
#   - the APK is re-signed with the release keystore, not Flutter's debug key.
#
# Environment:
#   STRICT_CONTROLLER_URL       https://api.example.com            (required)
#   STRICT_SIGNING_PUBLIC_KEY   base64 raw Ed25519 public key       (required)
#   SING_BOX_LIBBOX_REF         full 40-char reviewed commit SHA    (default: apps/client/libbox.ref)
#   STRICT_SIGNING_KEY_ID       key id the controller signs with    (default primary)
#   APP_VERSION                 version name                        (default 0.1.0)
#   APP_BUILD_NUMBER            version code; must increase          (default 1)
#   OUT_DIR                     artifact directory                  (default build/dist)
#   SKIP_LIBBOX=1               reuse an existing libbox.aar
#   ANDROID_KEYSTORE_PATH / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS
#   ANDROID_KEY_PASSWORD        (defaults to the keystore password)
#
set -euo pipefail

CLIENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_VERSION="${APP_VERSION:-0.1.0}"
APP_BUILD_NUMBER="${APP_BUILD_NUMBER:-1}"
OUT_DIR="${OUT_DIR:-${CLIENT_DIR}/build/dist}"

require() {
  local name="$1" hint="$2"
  if [[ -z "${!name:-}" ]]; then
    printf 'error: %s is required — %s\n' "$name" "$hint" >&2
    exit 1
  fi
}

require STRICT_CONTROLLER_URL 'the public HTTPS URL of the controller'
require STRICT_SIGNING_PUBLIC_KEY 'base64 of the controller Ed25519 public key'

# The native engine commit is pinned in the repository; the variable only
# overrides it for an out-of-band rebuild.
if [[ -z "${SING_BOX_LIBBOX_REF:-}" && -f "${CLIENT_DIR}/libbox.ref" ]]; then
  SING_BOX_LIBBOX_REF="$(tr -d '[:space:]' < "${CLIENT_DIR}/libbox.ref")"
fi
export SING_BOX_LIBBOX_REF
require SING_BOX_LIBBOX_REF 'pin one in apps/client/libbox.ref, or set SING_BOX_LIBBOX_REF'

if [[ "$STRICT_CONTROLLER_URL" != https://* ]]; then
  printf 'error: STRICT_CONTROLLER_URL must use https:// in a production build; got: %s\n' "$STRICT_CONTROLLER_URL" >&2
  exit 1
fi

command -v flutter >/dev/null || { echo 'Flutter is required' >&2; exit 1; }

AAR="${CLIENT_DIR}/packages/libbox_bridge/android/libs/libbox.aar"
if [[ "${SKIP_LIBBOX:-0}" != "1" ]]; then
  "${CLIENT_DIR}/tool/build-libbox.sh" --android-only
fi
if [[ ! -f "$AAR" ]]; then
  echo "libbox.aar is missing at $AAR" >&2
  echo 'An APK without it installs but cannot connect: build it, or set SKIP_LIBBOX=1 only if you know it is present.' >&2
  exit 1
fi

cd "$CLIENT_DIR"
flutter create --platforms=android .
"${CLIENT_DIR}/tool/configure-android-host.sh"
flutter pub get

flutter build apk --release \
  --build-name "$APP_VERSION" \
  --build-number "$APP_BUILD_NUMBER" \
  --dart-define=STRICT_ENV=production \
  --dart-define=STRICT_CONTROLLER_URL="$STRICT_CONTROLLER_URL" \
  --dart-define=STRICT_SIGNING_PUBLIC_KEY="$STRICT_SIGNING_PUBLIC_KEY" \
  --dart-define=STRICT_SIGNING_KEY_ID="${STRICT_SIGNING_KEY_ID:-primary}" \
  --dart-define=STRICT_REQUEST_TIMEOUT_SECONDS="${STRICT_REQUEST_TIMEOUT_SECONDS:-15}"

mkdir -p "$OUT_DIR"
APK_OUT="${OUT_DIR}/strict-proxy-${APP_VERSION}-${APP_BUILD_NUMBER}.apk"
"${CLIENT_DIR}/tool/sign-android-apk.sh" \
  "${CLIENT_DIR}/build/app/outputs/flutter-apk/app-release.apk" \
  "$APK_OUT"

echo
echo "Release APK ready: $APK_OUT"
echo "Install: adb install -r \"$APK_OUT\""
