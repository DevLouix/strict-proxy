#!/usr/bin/env bash
#
# Publish a built APK (or a directory of per-ABI APKs) to the controller's
# in-app update feed, then verify the feed actually offers it.
#
# This is the scripted equivalent of the admin dashboard's Client apps screen:
# it logs in as an administrator, uploads each APK under one build number,
# publishes the build, and downloads it back to compare SHA-256 hashes. Use it
# in a release pipeline; use the dashboard for a one-off.
#
# Usage:
#   APP_VERSION=0.2.0 APP_BUILD_NUMBER=20 \
#   CONTROLLER_URL=https://strictproxy.devlouix.com \
#   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='...' \
#   ./apps/client/tool/publish-android-release.sh [APK_DIR]
#
# APK_DIR defaults to apps/client/build/dist. File names produced by
# tool/build-release-android.sh end in `-<abi>.apk`, which is how each file's
# ABI is recognised; anything else is uploaded as `universal`.
#
# Environment:
#   CONTROLLER_URL      controller base URL                        (required)
#   ADMIN_EMAIL         administrator email                        (required*)
#   ADMIN_PASSWORD      administrator password                     (required*)
#   ADMIN_TOKEN         existing admin access token, skips login   (*instead of email/password)
#   APP_VERSION         version name                               (required)
#   APP_BUILD_NUMBER    build number; must increase                (required)
#   NOTES               release notes shown in the app             (optional)
#   PUBLISH=0           upload as a draft instead of publishing    (default 1)
#   CONTROLLER_CA_CERT  extra CA bundle for curl                    (optional)
#
set -euo pipefail

CLIENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK_DIR="${1:-${CLIENT_DIR}/build/dist}"

require() {
  local name="$1" hint="$2"
  if [[ -z "${!name:-}" ]]; then
    printf 'error: %s is required — %s\n' "$name" "$hint" >&2
    exit 1
  fi
}

require CONTROLLER_URL 'e.g. https://strictproxy.devlouix.com'
require APP_VERSION 'e.g. 0.2.0'
require APP_BUILD_NUMBER 'the version code, above the installed build'

CONTROLLER_URL="${CONTROLLER_URL%/}"
APP_BUILD_NUMBER="${APP_BUILD_NUMBER//[^0-9]/}"
[[ -n "$APP_BUILD_NUMBER" && "$APP_BUILD_NUMBER" -gt 0 ]] \
  || { echo 'error: APP_BUILD_NUMBER must be a positive whole number' >&2; exit 1; }

[[ -d "$APK_DIR" ]] || { echo "error: no APK directory at $APK_DIR" >&2; exit 1; }
shopt -s nullglob
APKS=("$APK_DIR"/*.apk)
[[ ${#APKS[@]} -gt 0 ]] || { echo "error: no APKs in $APK_DIR" >&2; exit 1; }

command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 1; }

CURL=(curl -sS)
if [[ -n "${CONTROLLER_CA_CERT:-}" ]]; then
  CURL+=(--cacert "$CONTROLLER_CA_CERT")
fi

# Percent-encode a query parameter without relying on jq.
urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

json_field() {
  python3 -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

# --- authenticate -----------------------------------------------------------

TOKEN="${ADMIN_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  require ADMIN_EMAIL 'an administrator account'
  require ADMIN_PASSWORD 'that account’s password'

  LOGIN_BODY="$(python3 -c '
import json, os
print(json.dumps({
    "email": os.environ["ADMIN_EMAIL"],
    "password": os.environ["ADMIN_PASSWORD"],
    "deviceId": "release-script",
    "deviceName": "publish-android-release",
}))')"

  LOGIN_RESPONSE="$(printf '%s' "$LOGIN_BODY" | "${CURL[@]}" -X POST \
    -H 'content-type: application/json' --data-binary @- \
    "${CONTROLLER_URL}/api/v1/auth/login")" || {
      echo 'error: sign-in failed; is CONTROLLER_URL reachable?' >&2
      exit 1
    }

  TOKEN="$(printf '%s' "$LOGIN_RESPONSE" | json_field accessToken 2>/dev/null)" || {
    echo "error: sign-in did not return an access token: ${LOGIN_RESPONSE}" >&2
    exit 1
  }
  ROLE="$(printf '%s' "$LOGIN_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("user",{}).get("role",""))' 2>/dev/null || true)"
  if [[ "$ROLE" != "admin" ]]; then
    echo "error: ${ADMIN_EMAIL} signed in with role '${ROLE:-unknown}', not 'admin'; that account cannot publish releases." >&2
    exit 1
  fi
fi

# --- upload one APK per ABI -------------------------------------------------

abi_for() {
  case "$1" in
    *-arm64-v8a) echo arm64-v8a ;;
    *-armeabi-v7a) echo armeabi-v7a ;;
    *-x86_64) echo x86_64 ;;
    *) echo universal ;;
  esac
}

NOTES="${NOTES:-}"
echo "Publishing build ${APP_BUILD_NUMBER} (v${APP_VERSION}) to ${CONTROLLER_URL}"

for apk in "${APKS[@]}"; do
  ABI="$(abi_for "${apk%.apk}")"
  URL="${CONTROLLER_URL}/api/v1/admin/client-apps/android/releases/${APP_BUILD_NUMBER}/artifacts?version=$(urlencode "$APP_VERSION")&abi=${ABI}&notes=$(urlencode "$NOTES")"
  printf '  uploading %-42s as %s ... ' "$(basename "$apk")" "$ABI"

  RESPONSE_FILE="$(mktemp)"
  CODE="$("${CURL[@]}" -o "$RESPONSE_FILE" -w '%{http_code}' -X PUT \
    -H "authorization: Bearer ${TOKEN}" \
    -H 'content-type: application/vnd.android.package-archive' \
    --data-binary "@${apk}" \
    "$URL")" || { echo 'FAILED'; rm -f "$RESPONSE_FILE"; exit 1; }
  RESPONSE="$(cat "$RESPONSE_FILE")"; rm -f "$RESPONSE_FILE"
  if [[ "$CODE" != '201' ]]; then
    echo "FAILED (HTTP ${CODE})"
    echo "$RESPONSE" >&2
    exit 1
  fi

  SERVER_SHA="$(printf '%s' "$RESPONSE" | python3 -c '
import json, sys
release = json.load(sys.stdin)
print((release.get("artifact") or {}).get("sha256") or "")
')"
  if [[ -z "$SERVER_SHA" ]]; then
    echo "error: unexpected upload response (HTTP ${CODE}):" >&2
    echo "$RESPONSE" >&2
    exit 1
  fi
  LOCAL_SHA="$(sha256sum "$apk" | cut -d' ' -f1)"
  if [[ "$SERVER_SHA" != "$LOCAL_SHA" ]]; then
    echo 'FAILED'
    echo "error: the controller stored a different file (server ${SERVER_SHA}, local ${LOCAL_SHA})" >&2
    exit 1
  fi
  echo 'ok'
done

# --- publish ----------------------------------------------------------------

if [[ "${PUBLISH:-1}" == "1" ]]; then
  STATUS_FILE="$(mktemp)"
  CODE="$("${CURL[@]}" -o "$STATUS_FILE" -w '%{http_code}' -X POST \
    -H "authorization: Bearer ${TOKEN}" \
    -H 'content-type: application/json' \
    --data '{"status":"published"}' \
    "${CONTROLLER_URL}/api/v1/admin/client-apps/android/releases/${APP_BUILD_NUMBER}/status")" \
    || { rm -f "$STATUS_FILE"; echo 'error: publishing the build failed at the network level' >&2; exit 1; }
  if [[ "$CODE" != '200' ]]; then
    echo "error: publishing build ${APP_BUILD_NUMBER} was refused (HTTP ${CODE}): $(cat "$STATUS_FILE")" >&2
    rm -f "$STATUS_FILE"
    exit 1
  fi
  rm -f "$STATUS_FILE"
  echo "Published build ${APP_BUILD_NUMBER}."
else
  echo "Uploaded build ${APP_BUILD_NUMBER} as a draft (PUBLISH=0)."
fi

# --- verify the feed the app reads -----------------------------------------

METADATA="$("${CURL[@]}" "${CONTROLLER_URL}/api/v1/app/android")"
OFFERED_BUILD="$(printf '%s' "$METADATA" | json_field buildNumber)"
if [[ "$OFFERED_BUILD" != "$APP_BUILD_NUMBER" ]]; then
  echo "error: the update feed offers build ${OFFERED_BUILD}, not ${APP_BUILD_NUMBER}" >&2
  exit 1
fi

CHECK_ABI="$(abi_for "${APKS[0]%.apk}")"
DOWNLOAD_PATH="$(printf '%s' "$METADATA" | python3 -c '
import json, sys
release = json.load(sys.stdin)
for artifact in release.get("artifacts", []):
    if artifact["abi"] == sys.argv[1]:
        print(artifact["url"])
        break
else:
    raise SystemExit(f"no artifact for {sys.argv[1]}")
' "$CHECK_ABI")"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"${CURL[@]}" -L -o "$TMP/download.apk" "${CONTROLLER_URL}${DOWNLOAD_PATH}"
REMOTE_SHA="$(sha256sum "$TMP/download.apk" | cut -d' ' -f1)"
[[ "$REMOTE_SHA" == "$(sha256sum "${APKS[0]}" | cut -d' ' -f1)" ]] || {
  echo 'error: the APK served by the update feed differs from the uploaded file' >&2
  exit 1
}

echo "Verified: the update feed offers build ${OFFERED_BUILD} and serves ${CHECK_ABI} bytes matching ${APKS[0]##*/}."
echo "Installed apps will now be offered v${APP_VERSION} (build ${APP_BUILD_NUMBER})."
