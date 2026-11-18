#!/usr/bin/env sh
set -eu

# Docker initialises a named volume as root:root, but the controller runs as
# `strictproxy`. Without this the first APK upload fails with EACCES and the
# dashboard (and the release pipeline) only see "internal error". Repair the
# release directory as root, then run the rest of the entrypoint unprivileged.
if [ "$(id -u)" = "0" ]; then
  storage="${CLIENT_ANDROID_STORAGE_DIR:-/var/lib/strict-proxy/client-releases}"
  mkdir -p "$storage"
  chown strictproxy:strictproxy "$storage"
  exec gosu strictproxy "$0" "$@"
fi

/usr/local/bin/validate-controller-env

# Apply the committed schema migrations.
#
# `migrate` rather than `push`: push introspects whatever is already in the
# database and reconciles it, which keeps no history and would silently accept a
# drifted environment. migrate applies apps/controller/drizzle/*.sql in order and
# is a no-op once caught up, so re-running it on every boot is safe.
#
# Compose declares Postgres healthy before this runs, but on a cold start the
# first connection can still be refused, so retry before giving up.
attempt=1
max_attempts="${DB_INIT_MAX_ATTEMPTS:-30}"
until npm run db:migrate -w apps/controller; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "database migration failed after $attempt attempts" >&2
    exit 1
  fi
  echo "database is not ready; retrying migration ($attempt/$max_attempts)" >&2
  attempt=$((attempt + 1))
  sleep 2
done

exec node --import tsx apps/controller/src/server.ts