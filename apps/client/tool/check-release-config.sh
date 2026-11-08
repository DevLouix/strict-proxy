#!/usr/bin/env bash
#
# Fail fast when the Android artifact cannot be built as a signed release.
#
# The push workflow publishes one thing: a signed, release-configured APK. It
# deliberately does not fall back to a debug build, because a debug-signed APK
# installs but can never be updated with the real key. When configuration is
# missing, that is an operator error worth a red job with the exact list.
#
# Environment (set by the workflow from repository secrets/variables):
#   ANDROID_KEYSTORE_BASE64    secret   base64 of the release keystore
#   ANDROID_KEYSTORE_PASSWORD  secret
#   ANDROID_KEY_ALIAS          secret
#   ANDROID_KEY_PASSWORD       secret   optional; defaults to the keystore one
#   CLIENT_CONTROLLER_URL      variable public HTTPS controller URL
#   CLIENT_SIGNING_PUBLIC_KEY  variable base64 of 32 raw Ed25519 bytes
set -euo pipefail

MISSING=()
check() {
  local kind="$1" name="$2" value="$3"
  [[ -n "$value" ]] || MISSING+=("$kind $name")
}

ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-}"
check secret ANDROID_KEYSTORE_BASE64 "${ANDROID_KEYSTORE_BASE64:-}"
check secret ANDROID_KEYSTORE_PASSWORD "${ANDROID_KEYSTORE_PASSWORD:-}"
check secret ANDROID_KEY_ALIAS "${ANDROID_KEY_ALIAS:-}"
check variable CLIENT_CONTROLLER_URL "${CLIENT_CONTROLLER_URL:-}"
check variable CLIENT_SIGNING_PUBLIC_KEY "${CLIENT_SIGNING_PUBLIC_KEY:-}"

if ((${#MISSING[@]})); then
  {
    echo 'error: the Android artifact needs a signed release build, but its configuration is incomplete.'
    echo 'missing:'
    printf '  - %s\n' "${MISSING[@]}"
    echo
    echo 'Set them once, then re-run:'
    echo '  Settings -> Secrets and variables -> Actions (Secrets and Variables tabs)'
    echo '  or, with gh authenticated as a repository admin:'
    echo '    base64 -w0 upload.jks | gh secret set ANDROID_KEYSTORE_BASE64'
    echo "    gh secret set ANDROID_KEYSTORE_PASSWORD --body '<keystore password>'"
    echo '    gh secret set ANDROID_KEY_ALIAS --body upload'
    echo "    gh secret set ANDROID_KEY_PASSWORD --body '<key password>'"
    echo "    gh variable set CLIENT_CONTROLLER_URL --body 'https://api.example.com'"
    echo '    gh variable set CLIENT_SIGNING_PUBLIC_KEY --body "$(openssl pkey -in signing-key.pem -pubout -outform DER | tail -c 32 | base64)"'
    echo
    echo 'Full walkthrough: docs/RELEASE-CLIENT.md -> GitHub configuration'
    echo 'One command: apps/client/tool/setup-release-secrets.sh'
  } >&2
  exit 1
fi

# Shape checks: a typo should fail here, not forty minutes into a native build.
[[ "$CLIENT_CONTROLLER_URL" == https://* ]] \
  || { printf 'error: CLIENT_CONTROLLER_URL must use https://; got: %s\n' "$CLIENT_CONTROLLER_URL" >&2; exit 1; }

decode_base64() {
  if openssl base64 -d -A 2>/dev/null; then
    return 0
  fi
  base64 --decode 2>/dev/null
}
export -f decode_base64

KEY_BYTES="$(printf '%s' "$CLIENT_SIGNING_PUBLIC_KEY" | decode_base64 | wc -c | tr -d ' ')"
[[ "$KEY_BYTES" == "32" ]] \
  || { printf 'error: CLIENT_SIGNING_PUBLIC_KEY must be base64 of 32 raw Ed25519 bytes (decoded %s bytes)\n' "$KEY_BYTES" >&2; exit 1; }

KEYSTORE_BYTES="$(printf '%s' "$ANDROID_KEYSTORE_BASE64" | decode_base64 | wc -c | tr -d ' ')"
[[ "$KEYSTORE_BYTES" != "0" ]] \
  || { printf 'error: ANDROID_KEYSTORE_BASE64 does not decode to a keystore\n' >&2; exit 1; }
((KEYSTORE_BYTES > 1000)) \
  || { printf 'error: ANDROID_KEYSTORE_BASE64 decoded to only %s bytes; is it a JKS/PKCS12 file?\n' "$KEYSTORE_BYTES" >&2; exit 1; }

echo "Release configuration present: keystore ($KEYSTORE_BYTES bytes), controller $CLIENT_CONTROLLER_URL, 32-byte signing key"
