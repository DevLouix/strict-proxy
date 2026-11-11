# Backup and recovery

Two backups protect a deployment, and they answer different questions.

| Backup | Question it answers | Contains |
|---|---|---|
| `pg_dump` / the `pgdata` volume | "restore this exact server" | everything, byte for byte |
| **Platform export** (`/api/v1/admin/backup/export`) | "rebuild this platform somewhere else, or recover rows without the volume" | durable platform state, as JSON |

Use both. `pg_dump` is the disaster path; the export is the path that still
works when the volume is gone but the controller and a browser are not, or when
you are moving to a new host. Neither replaces `signing-key.pem` and the
environment — those are files, not database rows, and a restore without them
produces a platform whose clients reject every signed bundle.

## What the export contains

| Table | Why it is included |
|---|---|
| `users` | accounts and password hashes (bcrypt — sign-in works after a restore) |
| `subscriptions` | entitlement and period end |
| `nodes` | fleet rows, including the REALITY keypair and node HMAC secret |
| `node_enrollments` | issued enrollment tokens (hashes only) and their state |
| `node_credentials` | per-user VLESS UUIDs and short-ids |
| `billing_checkouts` | checkout history and provider references |
| `payment_events` | webhook idempotency ledger |
| `usage_rollups` | bandwidth accounting |
| `platform_settings` | operator settings; the SMTP password stays encrypted |
| `client_releases` | Android build metadata, notes and publish state |
| `client_release_artifacts` | per-ABI file names, sizes and checksums |
| `client_crash_reports` | crash reports shown on the Client apps screen |

Deliberately **excluded**, because they are credentials rather than state:

- `devices`, `refresh_tokens` — restoring live sessions would be a security
  regression. Everyone signs in again, which the import response says.
- `revoked_access_tokens` — meaningless once tokens are reissued.
- `password_reset_tokens` — short-lived, single-use, and an import must not
  resurrect an unused reset link.

Not in the JSON at all, and required for a working restore:

- `SIGNING_PRIVATE_KEY_PEM` + `SIGNING_KEY_ID` — without the same key, installed
  clients reject every bundle as tampered.
- `SETTINGS_ENCRYPTION_KEY` (or the `JWT_SECRET` fallback) — the exported SMTP
  password is ciphertext; a different key makes it unreadable.
- `PAYMENT_WEBHOOK_SECRET`, `OPENPAY_*`, `PUBLIC_APP_URL`, `CORS_ORIGINS` — the
  environment is the deployment's configuration, not its data.
- Anything on node VPSes: their identity lives in the `nodeidentity` volume. The
  backup carries the controller's half, so a node that still has its volume
  reconnects without re-enrolling.
- Android APK files. The release and artifact rows are restored, but the files
  live under `CLIENT_ANDROID_STORAGE_DIR` (`var/client-releases` by default, or
  the mounted volume in Docker). Copy that directory to the new controller if
  the platform serves app updates; otherwise the metadata points at files that
  are not there.

## Export

From an administrator session (the access token from `/admin`, or a script):

```bash
TOKEN=...   # admin access token
curl -fsS -H "Authorization: Bearer $TOKEN" \
  https://api.example.com/api/v1/admin/backup/export \
  -o "strict-proxy-backup-$(date +%F).json"
```

The same download is available at **Admin → Backup → Download backup**. The
response is an attachment (`Content-Disposition`), never cached, and contains
password hashes and node private keys: store it like the database itself,
encrypted at rest and not in git.

Shape:

```json
{
  "format": "strict-proxy-backup",
  "version": 1,
  "generatedAt": "2026-11-08T12:00:00.000Z",
  "signingKeyId": "primary",
  "counts": { "users": 12, "nodes": 3, "node_credentials": 30 },
  "tables": { "users": [ ... ], "nodes": [ ... ] }
}
```

## Import

Import **replaces** every row in the tables above. It is transactional: the
truncate and every insert run in one transaction under an advisory lock, so a
rejected or failing import leaves the running platform exactly as it was.

```bash
curl -fsS -X POST https://api.example.com/api/v1/admin/backup/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @<(jq -c '. + {confirm:"replace"}' strict-proxy-backup-2026-11-08.json)
```

Or send the file with the field added:

```bash
jq -c '. + {confirm:"replace"}' backup.json > backup.import.json
curl -fsS -X POST https://api.example.com/api/v1/admin/backup/import \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @backup.import.json
```

`confirm: "replace"` is required; without it the endpoint answers
`400 CONFIRMATION_REQUIRED` and writes nothing. The response reports per-table
row counts and reminds you that all sessions were replaced. The same flow is in
**Admin → Backup → Restore this backup**; it asks for confirmation, then signs
the current session out so you can sign in with an account from the snapshot.

Refused with `400 INVALID_BACKUP`, and nothing written:

- a different `format` or an unsupported `version` (restore with the controller
  release that produced the backup);
- unknown tables — a newer snapshot is not half-applied;
- no users, or no user with `role: "admin"` — a restore must leave the platform
  manageable;
- any row that violates a constraint (foreign key, unique) — the transaction
  rolls back.

## After a restore

1. Put the original `signing-key.pem` in place as `SIGNING_PRIVATE_KEY_PEM`
   (and the same `SIGNING_KEY_ID`), or clients will report tampered bundles.
2. Restore the same `SETTINGS_ENCRYPTION_KEY`; otherwise re-enter the SMTP
   password in **Settings**.
3. Sign in again: the token you imported with belongs to a replaced user row.
4. If you serve Android updates, copy `CLIENT_ANDROID_STORAGE_DIR` from the old
   controller. A restored release row without its APK will not download.
5. Confirm the fleet: nodes with intact identity volumes return to `online`
   within about 30 seconds; nodes without one need a new enrollment token.
6. `curl -fsS https://api.example.com/readyz` and open `/admin`.
7. Keep the snapshot used for the restore with the deployment's environment
   backup, so the pair can be replayed.

## Restore drill

Do this once before you need it, on a staging host:

1. Export from production.
2. Start an empty controller with the same signing key and settings key.
3. Import the snapshot, sign in, and check **Users**, **Nodes** and **Payments**
   against production.
4. Run `scripts/smoke-server.sh` with `BASE_URL` pointing at the staging host.

An untested backup is a hope, not a backup.
