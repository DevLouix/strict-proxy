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
#   STRICT_ANDROID_APP_ID       expected application id             (default com.strictproxy.client)
#   OUT_DIR                     artifact directory                  (default build/dist)
#   SPLIT_ABI                   build one APK per ABI (default 1). Set 0 for a
#                               single universal APK
#   TARGET_PLATFORMS            comma-separated Flutter target platforms.
#                               Unset builds every ABI. The release workflow
#                               passes android-arm,android-arm64: x86_64 only
#                               runs in emulators, and each extra ABI costs a
#                               full AOT compile plus a sign/verify pass.
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
# The Gradle plugin consumes the unpacked jar/jni form, not the AAR itself.
"${CLIENT_DIR}/tool/unpack-libbox-aar.sh"

cd "$CLIENT_DIR"
flutter create --platforms=android .
"${CLIENT_DIR}/tool/configure-android-host.sh"
flutter pub get

# A universal APK carries the native engine for every ABI (the engine is the
# bulk of the download). Splitting keeps each installation to the one CPU it
# runs on; the in-app updater asks the controller for its own ABI.
SPLIT_ABI="${SPLIT_ABI:-1}"
SPLIT_ARGS=()
if [[ "$SPLIT_ABI" == "1" ]]; then
  SPLIT_ARGS+=(--split-per-abi)
fi

# An empty TARGET_PLATFORMS leaves Flutter's default ABI set untouched, so a
# local universal build still covers an emulator.
TARGET_PLATFORMS="${TARGET_PLATFORMS:-}"
PLATFORM_ARGS=()
if [[ -n "$TARGET_PLATFORMS" ]]; then
  PLATFORM_ARGS+=(--target-platform "$TARGET_PLATFORMS")
fi

flutter build apk --release "${SPLIT_ARGS[@]}" "${PLATFORM_ARGS[@]}" \
  --build-name "$APP_VERSION" \
  --build-number "$APP_BUILD_NUMBER" \
  --dart-define=STRICT_ENV=production \
  --dart-define=STRICT_CONTROLLER_URL="$STRICT_CONTROLLER_URL" \
  --dart-define=STRICT_SIGNING_PUBLIC_KEY="$STRICT_SIGNING_PUBLIC_KEY" \
  --dart-define=STRICT_SIGNING_KEY_ID="${STRICT_SIGNING_KEY_ID:-primary}" \
  --dart-define=STRICT_REQUEST_TIMEOUT_SECONDS="${STRICT_REQUEST_TIMEOUT_SECONDS:-15}" \
  --dart-define=APP_VERSION="$APP_VERSION" \
  --dart-define=APP_BUILD_NUMBER="$APP_BUILD_NUMBER"

mkdir -p "$OUT_DIR"
shopt -s nullglob

# Sign and check every artifact before announcing success: a release with one
# unsigned or engine-less ABI is worse than a failed build, because the phone
# that matches it cannot update.
if [[ "$SPLIT_ABI" == "1" ]]; then
  APKS=(build/app/outputs/flutter-apk/app-*-release.apk)
  if [[ ${#APKS[@]} -eq 0 ]]; then
    echo 'flutter --split-per-abi produced no APKs' >&2
    exit 1
  fi
  for apk in "${APKS[@]}"; do
    name="$(basename "$apk")"
    abi="${name#app-}"
    abi="${abi%-release.apk}"
    out="${OUT_DIR}/strict-proxy-${APP_VERSION}-${APP_BUILD_NUMBER}-${abi}.apk"
    "${CLIENT_DIR}/tool/sign-android-apk.sh" "$apk" "$out"
    "${CLIENT_DIR}/tool/verify-android-apk.sh" "$out"
    echo "Release APK ready: $out (${abi})"
  done
  echo
  echo "Install the APK matching the device: adb install -r \"${OUT_DIR}/strict-proxy-${APP_VERSION}-${APP_BUILD_NUMBER}-arm64-v8a.apk\""
else
  APK_OUT="${OUT_DIR}/strict-proxy-${APP_VERSION}-${APP_BUILD_NUMBER}.apk"
  "${CLIENT_DIR}/tool/sign-android-apk.sh" \
    "${CLIENT_DIR}/build/app/outputs/flutter-apk/app-release.apk" \
    "$APK_OUT"
  "${CLIENT_DIR}/tool/verify-android-apk.sh" "$APK_OUT"
  echo
  echo "Release APK ready: $APK_OUT"
  echo "Install: adb install -r \"$APK_OUT\""
fi
