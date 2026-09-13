#!/usr/bin/env sh
set -eu

/usr/local/bin/validate-controller-env

# The database is declared healthy by Compose, but migrations can still race
# during a fresh deployment. Retry schema application before starting the API.
attempt=1
max_attempts="${DB_INIT_MAX_ATTEMPTS:-30}"
until npm run db:push -w apps/controller -- --force; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "database schema initialization failed after $attempt attempts" >&2
    exit 1
  fi
  echo "database is not ready; retrying schema initialization ($attempt/$max_attempts)" >&2
  attempt=$((attempt + 1))
  sleep 2
done

exec node --import tsx apps/controller/src/server.ts
