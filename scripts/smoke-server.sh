#!/usr/bin/env bash
set -euo pipefail

# Live server smoke test. The caller supplies BASE_URL and test credentials via
# environment; no credential values are printed.
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
TEST_EMAIL="${TEST_EMAIL:-smoke-$(date +%s)@example.test}"
TEST_PASSWORD="${TEST_PASSWORD:-smoke-password-2026}"

request_code() {
  curl -sS -o /tmp/strict-proxy-smoke-body -w '%{http_code}' "$@"
}

health_code=$(request_code "$BASE_URL/healthz")
ready_code=$(request_code "$BASE_URL/readyz")
register_code=$(curl -sS -o /tmp/strict-proxy-smoke-register.json -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" \
  "$BASE_URL/api/v1/auth/register")
login_code=$(curl -sS -o /tmp/strict-proxy-smoke-login.json -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"deviceId\":\"server-smoke\"}" \
  "$BASE_URL/api/v1/auth/login")

TOKEN=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('/tmp/strict-proxy-smoke-login.json')); if(typeof j.accessToken !== 'string') process.exit(1); process.stdout.write(j.accessToken)")
me_code=$(curl -sS -o /tmp/strict-proxy-smoke-me.json -w '%{http_code}' \
  -H "authorization: Bearer $TOKEN" "$BASE_URL/api/v1/me")
unauth_code=$(request_code "$BASE_URL/api/v1/me")
ips_code=$(request_code "$BASE_URL/api/v1/network/nodes/public-ips")

printf 'health=%s ready=%s register=%s login=%s me=%s unauthenticated=%s public_ips=%s\n' \
  "$health_code" "$ready_code" "$register_code" "$login_code" "$me_code" "$unauth_code" "$ips_code"

[ "$health_code" = 200 ] \
  && [ "$ready_code" = 200 ] \
  && [ "$register_code" = 201 ] \
  && [ "$login_code" = 200 ] \
  && [ "$me_code" = 200 ] \
  && [ "$unauth_code" = 401 ] \
  && [ "$ips_code" = 200 ]

echo 'server smoke test passed'
