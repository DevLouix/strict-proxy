#!/usr/bin/env bash
#
# Re-sign a Flutter release APK with the deployment keystore.
#
# `flutter build apk --release` uses the generated Android project's debug
# signing config unless one is configured, and debug keys differ per machine.
# An APK signed that way cannot be updated later, so every artifact handed to
# users is re-signed here with the upload key.
#
# Requires: zip, zipalign and apksigner from the Android SDK build-tools.
#
# Environment:
#   ANDROID_KEYSTORE_PATH      path to the .jks/.keystore
#   ANDROID_KEYSTORE_PASSWORD  keystore password
#   ANDROID_KEY_ALIAS          key alias
#   ANDROID_KEY_PASSWORD       key password (defaults to the keystore password)
#
set -euo pipefail

APK_IN="${1:?usage: sign-android-apk.sh <input.apk> <output.apk>}"
APK_OUT="${2:?usage: sign-android-apk.sh <input.apk> <output.apk>}"

require() {
  local name="$1" hint="$2"
  if [[ -z "${!name:-}" ]]; then
    printf 'error: %s is required — %s\n' "$name" "$hint" >&2
    exit 1
  fi
}

require ANDROID_KEYSTORE_PATH 'path to the release keystore'
require ANDROID_KEYSTORE_PASSWORD 'the keystore password'
require ANDROID_KEY_ALIAS 'the key alias inside the keystore'
ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}"
export ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_PASSWORD

[[ -f "$APK_IN" ]] || { echo "input APK not found: $APK_IN" >&2; exit 1; }
[[ -f "$ANDROID_KEYSTORE_PATH" ]] || { echo "keystore not found: $ANDROID_KEYSTORE_PATH" >&2; exit 1; }
command -v zip >/dev/null || { echo 'zip is required to strip the debug signature' >&2; exit 1; }

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$SDK" ]]; then
  echo 'ANDROID_SDK_ROOT (or ANDROID_HOME) is not set' >&2
  exit 1
fi

BUILD_TOOLS="$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1 || true)"
if [[ -z "$BUILD_TOOLS" ]]; then
  echo "no Android build-tools found under $SDK/build-tools" >&2
  exit 1
fi
ZIPALIGN="$BUILD_TOOLS/zipalign"
APKSIGNER="$BUILD_TOOLS/apksigner"
for tool in "$ZIPALIGN" "$APKSIGNER"; do
  [[ -x "$tool" ]] || { echo "missing Android build-tool: $tool" >&2; exit 1; }
done

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

cp "$APK_IN" "$WORK_DIR/input.apk"

# Remove the v1 (JAR) signature the debug build carries. The v2/v3 signature
# block is replaced by apksigner; stray META-INF signature files would make the
# resulting APK fail verification.
zip -q -d "$WORK_DIR/input.apk" 'META-INF/*.RSA' 'META-INF/*.SF' 'META-INF/*.MF' || true

"$ZIPALIGN" -f -p 4 "$WORK_DIR/input.apk" "$WORK_DIR/aligned.apk"

mkdir -p "$(dirname "$APK_OUT")"
"$APKSIGNER" sign \
  --ks "$ANDROID_KEYSTORE_PATH" \
  --ks-key-alias "$ANDROID_KEY_ALIAS" \
  --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
  --key-pass env:ANDROID_KEY_PASSWORD \
  --out "$APK_OUT" \
  "$WORK_DIR/aligned.apk"

"$APKSIGNER" verify --print-certs "$APK_OUT"
echo "signed APK: $APK_OUT"
