#!/usr/bin/env sh
set -eu

require_nonempty() {
  name="$1"
  eval "value=\${$name-}"
  if [ -z "$value" ]; then
    echo "required controller environment variable is missing: $name" >&2
    exit 1
  fi
}

require_nonempty JWT_SECRET
require_nonempty SIGNING_PRIVATE_KEY_PEM
require_nonempty PAYMENT_WEBHOOK_SECRET

if [ "${#JWT_SECRET}" -lt 32 ]; then
  echo "JWT_SECRET must contain at least 32 characters" >&2
  exit 1
fi
if [ "${#PAYMENT_WEBHOOK_SECRET}" -lt 32 ]; then
  echo "PAYMENT_WEBHOOK_SECRET must contain at least 32 characters" >&2
  exit 1
fi
case "$SIGNING_PRIVATE_KEY_PEM" in
  *"BEGIN PRIVATE KEY"*"END PRIVATE KEY"*) : ;;
  *) echo "SIGNING_PRIVATE_KEY_PEM is not a PKCS#8 private-key PEM" >&2; exit 1 ;;
esac

# Parse the actual key. This catches truncated/base64-corrupt PEM values before
# the service starts accepting traffic.
if ! SIGNING_PRIVATE_KEY_PEM="$SIGNING_PRIVATE_KEY_PEM" node -e "require('node:crypto').createPrivateKey(process.env.SIGNING_PRIVATE_KEY_PEM.replace(/\\\\n/g, '\\n'))"; then
  echo "SIGNING_PRIVATE_KEY_PEM could not be parsed" >&2
  exit 1
fi

printf '%s\\n' '[controller] required environment validation passed'
