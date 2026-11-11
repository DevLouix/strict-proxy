#!/usr/bin/env bash
#
# Fail unless a built APK is the client we meant to ship.
#
# Three mistakes are cheap to make and expensive to discover after publishing:
#   - the APK still carries Flutter's com.example placeholder, which Play and
#     most stores refuse and which can never be updated in place;
#   - the launcher label is the raw project name;
#   - the native engine is missing, so the app installs and cannot connect.
#
# Requires aapt (Android SDK build-tools) and unzip.
#
# Usage: verify-android-apk.sh <apk> [expected-application-id]
# Environment:
#   STRICT_ANDROID_APP_ID   expected id (default com.strictproxy.client)
set -euo pipefail

APK="${1:?usage: verify-android-apk.sh <apk> [expected-application-id]}"
EXPECTED_ID="${2:-${STRICT_ANDROID_APP_ID:-com.strictproxy.client}}"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

[[ -f "$APK" ]] || fail "APK not found: $APK"
command -v unzip >/dev/null || fail 'unzip is required'

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
[[ -n "$SDK" ]] || fail 'ANDROID_SDK_ROOT (or ANDROID_HOME) is not set'
AAPT="$(find "$SDK/build-tools" -mindepth 2 -maxdepth 2 -type f -name aapt 2>/dev/null | sort -V | tail -1 || true)"
[[ -n "$AAPT" ]] || fail "no aapt under $SDK/build-tools — install Android build-tools"

BADGING="$("$AAPT" dump badging "$APK")" || fail "aapt could not read $APK"

PACKAGE="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"
LABEL="$(sed -n "s/^application-label:'\(.*\)'$/\1/p" <<<"$BADGING" | head -1)"

[[ -n "$PACKAGE" ]] || fail 'could not read the application id from the APK'
[[ "$PACKAGE" != com.example.* ]] || fail "APK still uses the placeholder id $PACKAGE; run tool/configure-android-host.sh"
[[ "$PACKAGE" == "$EXPECTED_ID" ]] || fail "APK application id is $PACKAGE, expected $EXPECTED_ID (override with STRICT_ANDROID_APP_ID)"
[[ -n "$LABEL" ]] || fail 'the APK has no launcher label'
[[ "$LABEL" != strict_proxy_client ]] || fail "launcher label is still the raw project name ($LABEL); run tool/configure-android-host.sh"

# The engine must actually be packaged, not merely present in the plugin source
# tree: AGP silently drops what it cannot see. A split APK only contains its own
# ABI, so check that every ABI present has the engine — and that at least one
# does.
# Read the listing once. Piping `unzip -l` into `grep -q` looks equivalent but
# fails under `pipefail`: grep exits at the first match, unzip then dies from
# SIGPIPE, and the pipeline reports 141 even though the entry exists.
ENTRIES="$(unzip -l "$APK")" || fail "unzip could not read $APK"
NATIVE_ABIS="$(sed -n 's#.*lib/\([^/]*\)/[^/]*\.so$#\1#p' <<<"$ENTRIES" | sort -u)"
[[ -n "$NATIVE_ABIS" ]] || fail 'the APK carries no native libraries; the engine was not bundled'
while IFS= read -r abi; do
  [[ -n "$abi" ]] || continue
  grep -q "lib/$abi/libbox\.so" <<<"$ENTRIES" \
    || fail "libbox.so is missing for $abi — the native engine was not bundled (see tool/build-libbox.sh)"
done <<<"$NATIVE_ABIS"

echo "APK verified: id=$PACKAGE label=$LABEL engine=libbox.so abis=$(tr '\n' ',' <<<"$NATIVE_ABIS" | sed 's/,$//')"
