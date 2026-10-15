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

# Billing catalog amounts are minor units (kobo/cents) and must be positive
# integers when set; a bad value would silently charge the wrong amount.
# An unset value is fine — the controller applies its own default.
for var in STANDARD_TIER_AMOUNT_MINOR PRO_TIER_AMOUNT_MINOR; do
  eval "amount=\${$var:-}"
  [ -z "$amount" ] && continue
  case "$amount" in
    *[!0-9]*) echo "$var must be a positive integer in minor units" >&2; exit 1 ;;
  esac
  if [ "$amount" -le 0 ]; then
    echo "$var must be greater than zero" >&2
    exit 1
  fi
done

# The OpenPay gateway is optional, but configuring it half-way (a key without
# its webhook secret, or vice versa) means signed webhooks can never be
# verified — refuse to boot rather than silently drop every payment event.
if [ -n "${OPENPAY_API_KEY:-}" ] && [ -z "${OPENPAY_WEBHOOK_SECRET:-}" ]; then
  echo "OPENPAY_API_KEY is set but OPENPAY_WEBHOOK_SECRET is empty; webhooks could never be verified" >&2
  exit 1
fi
if [ -n "${OPENPAY_WEBHOOK_SECRET:-}" ] && [ -z "${OPENPAY_API_KEY:-}" ]; then
  echo "OPENPAY_WEBHOOK_SECRET is set but OPENPAY_API_KEY is empty; checkouts could never be opened" >&2
  exit 1
fi

printf '%s\\n' '[controller] required environment validation passed'
