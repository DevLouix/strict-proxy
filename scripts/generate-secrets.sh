#!/usr/bin/env bash
#
# Generate the one-time secrets a deployment needs, in one command.
#
# Produces two gitignored files in the current directory (run from the repo
# root unless you mean somewhere else):
#
#   signing-key.pem   Ed25519 keypair. The controller signs config bundles with
#                     the private half; every client verifies with the public
#                     half. Never committed, always backed up.
#   secrets.txt       the generated values, mode 0600:
#                       POSTGRES_PASSWORD
#                       REDIS_PASSWORD
#                       SETTINGS_ENCRYPTION_KEY
#                       JWT_SECRET
#                       PAYMENT_WEBHOOK_SECRET
#                       SIGNING_PRIVATE_KEY_PEM    one line, \n escapes
#                       STRICT_SIGNING_PUBLIC_KEY  base64 of the raw 32 bytes
#
# Usage:
#   scripts/generate-secrets.sh [output-file]      default: secrets.txt
#
# Environment:
#   SIGNING_KEY_FILE   key path, default signing-key.pem
#   FORCE=1            overwrite existing files; this rotates the signing key
#                      and invalidates every client already deployed
#
# The public value is CLIENT_SIGNING_PUBLIC_KEY as a GitHub repository variable
# and STRICT_SIGNING_PUBLIC_KEY for a local client build. Only the public half
# ever leaves this machine.
set -euo pipefail

OUTPUT="${1:-secrets.txt}"
KEY_FILE="${SIGNING_KEY_FILE:-signing-key.pem}"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

command -v openssl >/dev/null || fail 'openssl is required'

if [[ -e "$KEY_FILE" || -e "$OUTPUT" ]] && [[ "${FORCE:-0}" != "1" ]]; then
  fail "$KEY_FILE or $OUTPUT already exists. Replacing the signing key
invalidates every deployed client (they verify with the old public key), and new
database and JWT secrets orphan the running deployment. Back both files up, then
re-run with FORCE=1 to rotate deliberately."
fi

umask 077
openssl genpkey -algorithm ed25519 -out "$KEY_FILE"

# The controller wants one line: real newlines become the two characters \n,
# which it unescapes at startup.
SIGNING_PRIVATE_KEY_PEM="$(awk 'BEGIN{ORS="\\n"} {print}' "$KEY_FILE")"
# The client wants the public half only: base64 of the last 32 DER bytes.
STRICT_SIGNING_PUBLIC_KEY="$(openssl pkey -in "$KEY_FILE" -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')"
[[ -n "$STRICT_SIGNING_PUBLIC_KEY" ]] || fail 'could not derive the public key'

# Write through a temporary file so a failure never leaves a half-filled file.
TMP="$(mktemp "${OUTPUT}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
{
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'SETTINGS_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'JWT_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')"
  printf 'PAYMENT_WEBHOOK_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')"
  printf 'SIGNING_PRIVATE_KEY_PEM="%s"\n' "$SIGNING_PRIVATE_KEY_PEM"
  printf 'STRICT_SIGNING_PUBLIC_KEY=%s\n' "$STRICT_SIGNING_PUBLIC_KEY"
} > "$TMP"
mv "$TMP" "$OUTPUT"
trap - EXIT

printf 'Wrote %s and %s (mode 0600)\n\n' "$OUTPUT" "$KEY_FILE"
printf 'Ed25519 public key (CLIENT_SIGNING_PUBLIC_KEY / STRICT_SIGNING_PUBLIC_KEY):\n'
printf '%s\n\n' "$STRICT_SIGNING_PUBLIC_KEY"
cat <<'EOF'
Back both files up: losing the key means rebuilding every client already
installed. Neither file is committed.

Next steps:
  controller   paste the values into .env.docker or the Dokploy Environment
               tab; keep SIGNING_PRIVATE_KEY_PEM on a single line
  client       gh variable set CLIENT_SIGNING_PUBLIC_KEY --body '<public key>'
               gh variable set CLIENT_CONTROLLER_URL --body 'https://api.example.com'
  docs         SETUP.md step 3, docs/DOKPLOY.md step 2, docs/RELEASE-CLIENT.md
EOF
