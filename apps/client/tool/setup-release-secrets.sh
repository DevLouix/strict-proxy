#!/usr/bin/env bash
#
# One-time setup: make push builds produce signed release APKs.
#
# Sets the four release-signing secrets and the two public build variables the
# `client` workflow reads, so every push to main/release/* ships a signed build
# instead of the debug fallback. Needs `gh` authenticated for the repository.
#
# Environment:
#   STRICT_CONTROLLER_URL     public HTTPS controller URL        (required)
#   SIGNING_KEY_FILE          controller signing private key     (default signing-key.pem)
#   ANDROID_KEYSTORE_PATH     keystore to create/reuse           (default upload.jks)
#   ANDROID_KEYSTORE_PASSWORD keystore password                  (generated when absent)
#   ANDROID_KEY_ALIAS         key alias                          (default upload)
#   ANDROID_KEY_PASSWORD      key password                       (defaults to the keystore one)
#   STRICT_ANDROID_APP_ID     expected application id            (default com.strictproxy.client)
#   DRY_RUN=1                 print the operations, change nothing
#
# Only the controller's PUBLIC key is uploaded. The private key never leaves the
# machine and is never stored in the repository or GitHub.
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
CONTROLLER_URL="${STRICT_CONTROLLER_URL:-}"
SIGNING_KEY_FILE="${SIGNING_KEY_FILE:-signing-key.pem}"
KEYSTORE="${ANDROID_KEYSTORE_PATH:-upload.jks}"
ALIAS="${ANDROID_KEY_ALIAS:-upload}"
KEYSTORE_PASSWORD="${ANDROID_KEYSTORE_PASSWORD:-}"
KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-}"
EXPECTED_ID="${STRICT_ANDROID_APP_ID:-com.strictproxy.client}"
PASSWORD_FILE="${KEYSTORE}.password"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

set_secret() {
  local name="$1" value="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'would run: gh secret set %s --body <redacted>\n' "$name"
  else
    gh secret set "$name" --body "$value"
  fi
}

set_variable() {
  local name="$1" value="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'would run: gh variable set %s --body %s\n' "$name" "$value"
  else
    gh variable set "$name" --body "$value"
  fi
}

[[ -n "$CONTROLLER_URL" ]] || fail 'set STRICT_CONTROLLER_URL to the controller public URL'
[[ "$CONTROLLER_URL" == https://* ]] || fail "STRICT_CONTROLLER_URL must use https://; got: $CONTROLLER_URL"
[[ -f "$SIGNING_KEY_FILE" ]] || fail "signing key not found: $SIGNING_KEY_FILE (it is the controller's SIGNING_PRIVATE_KEY_PEM key)"
command -v openssl >/dev/null || fail 'openssl is required'

if [[ "$DRY_RUN" != "1" ]]; then
  command -v gh >/dev/null || fail 'gh (GitHub CLI) is required'
  gh auth status >/dev/null 2>&1 || fail 'gh is not authenticated; run: gh auth login'
fi

# Public half only: 32 raw bytes, base64. This is what the client verifies with.
PUBLIC_KEY="$(openssl pkey -in "$SIGNING_KEY_FILE" -pubout -outform DER | tail -c 32 | base64)"
[[ -n "$PUBLIC_KEY" ]] || fail 'could not derive the public key from the signing key'

if [[ ! -f "$KEYSTORE" ]]; then
  command -v keytool >/dev/null || fail 'keytool (JDK) is required to generate the release keystore'
  if [[ -z "$KEYSTORE_PASSWORD" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      KEYSTORE_PASSWORD='<generated>'
    else
      KEYSTORE_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
    fi
  fi
  KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "would create keystore $KEYSTORE (alias $ALIAS) and save its password to $PASSWORD_FILE"
  else
    keytool -genkeypair -v \
      -keystore "$KEYSTORE" \
      -storepass "$KEYSTORE_PASSWORD" \
      -keypass "$KEY_PASSWORD" \
      -alias "$ALIAS" \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -dname 'CN=StrictProxy Upload'
    umask 077
    printf '%s\n' "$KEYSTORE_PASSWORD" > "$PASSWORD_FILE"
    echo "keystore password saved to $PASSWORD_FILE — back both files up"
  fi
else
  [[ -n "$KEYSTORE_PASSWORD" ]] || fail "keystore $KEYSTORE exists but ANDROID_KEYSTORE_PASSWORD is not set"
  KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"
fi

if [[ -f "$KEYSTORE" ]]; then
  KEYSTORE_BASE64="$(base64 -w0 "$KEYSTORE" 2>/dev/null || base64 "$KEYSTORE")"
else
  KEYSTORE_BASE64='<keystore bytes>'
fi

echo "Configuring release signing for $CONTROLLER_URL (application id $EXPECTED_ID)"
set_secret ANDROID_KEYSTORE_BASE64 "$KEYSTORE_BASE64"
set_secret ANDROID_KEYSTORE_PASSWORD "$KEYSTORE_PASSWORD"
set_secret ANDROID_KEY_ALIAS "$ALIAS"
set_secret ANDROID_KEY_PASSWORD "$KEY_PASSWORD"
set_variable CLIENT_CONTROLLER_URL "$CONTROLLER_URL"
set_variable CLIENT_SIGNING_PUBLIC_KEY "$PUBLIC_KEY"

if [[ "$DRY_RUN" == "1" ]]; then
  echo 'dry run: nothing was uploaded'
  exit 0
fi

echo
echo 'Done. The next push to main or release/* builds a signed release APK.'
echo "Back up $KEYSTORE and $PASSWORD_FILE: Android rejects updates signed by a different key."
