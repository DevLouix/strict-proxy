# Deploying on Dokploy

This is the live deployment path: one Dokploy server runs the controller and its
database, each exit VPS runs a node agent, and the Android client is built and
signed by the release workflow.

Dokploy runs Docker Compose behind its own Traefik instance. Both compose files
here are written for that: **no host ports on the controller**, and a shared
`dokploy-network` that Traefik reaches. If you use the repository's
`docker-compose.production.yml` with its bundled Caddy instead, follow
[SETUP.md](../SETUP.md) rather than this document.

Which environment file belongs to which service, and what the repository's
other Compose files are for, is summarised in [FILE-MAP.md](FILE-MAP.md).

## What runs where

| Piece | Where | Compose file | Needs |
|---|---|---|---|
| Controller + Postgres + Redis | One Dokploy server with a domain | `docker-compose.dokploy.yml` | 2 CPU / 2 GB RAM / 20 GB disk, a DNS record |
| Node agent | Each exit VPS | `docker-compose.dokploy-node.yml` | Public IPv4, `/dev/net/tun`, `NET_ADMIN`, UDP+TCP 443 |
| Flutter client | Built in GitHub Actions, installed by users | — | Android keystore, signing public key, libbox SHA |

Start with the controller. A node is useless until the controller can issue it
credentials, and a client is useless until both exist.

## 1. Before you start

1. Dokploy installed and reachable on the server.
2. A DNS `A` record for `api.example.com` pointing at that server. The domain
   must resolve before you enable HTTPS, or Let's Encrypt validation fails.
3. TCP 80 and 443 reachable inbound (Traefik needs 80 for the ACME challenge).
4. Ports `443/tcp` and `443/udp` reachable on **each exit VPS** for node traffic.

## 2. Generate the secrets

Run these somewhere safe and keep the output. From a checkout,
`scripts/generate-secrets.sh` runs every command in this section and writes
`secrets.txt` plus `signing-key.pem` (both mode 0600, both gitignored); the
commands are spelled out here so you can also generate a single value.

```bash
# Passwords: hex stays URL-safe inside DATABASE_URL and REDIS_URL.
openssl rand -hex 32    # POSTGRES_PASSWORD
openssl rand -hex 32    # REDIS_PASSWORD
openssl rand -hex 32    # SETTINGS_ENCRYPTION_KEY

# Secrets
openssl rand -base64 48 # JWT_SECRET
openssl rand -base64 48 # PAYMENT_WEBHOOK_SECRET

# Ed25519 signing key: the controller signs config bundles with it and every
# client verifies them with the public half.
openssl genpkey -algorithm ed25519 -out signing-key.pem
awk 'BEGIN{ORS="\\n"} {print}' signing-key.pem
#   ^ paste that whole line into SIGNING_PRIVATE_KEY_PEM (single line, \n escapes)

openssl pkey -in signing-key.pem -pubout -outform DER | tail -c 32 | base64
#   ^ the client build's STRICT_SIGNING_PUBLIC_KEY
```

Back up `signing-key.pem` and `.env.dokploy` together. Losing the signing key
means every installed client must be rebuilt; there is no way to re-sign for
them.

## 3. Deploy the controller

1. **Dokploy → Project → Create Service → Compose.**
2. Point it at this repository and branch `main`, with
   **Compose path** `docker-compose.dokploy.yml`.
3. Open the **Environment** tab and paste the filled-in controller section of
   [`.env.dokploy.example`](../.env.dokploy.example). At minimum replace:
   `PUBLIC_APP_URL`, both passwords, both URLs, `JWT_SECRET`,
   `SIGNING_PRIVATE_KEY_PEM`, `PAYMENT_WEBHOOK_SECRET`,
   `SETTINGS_ENCRYPTION_KEY`.
   `CONTROLLER_DATABASE_URL` and `CONTROLLER_REDIS_URL` must use the service
   names `postgres` and `redis` — inside a container, `localhost` is the
   container itself.

   `SIGNING_PRIVATE_KEY_PEM` must stay on **one** line, quotes included, with
   the `\n` sequences exactly as step 2 prints them. Pasting the PEM itself
   leaves real newlines in the environment file, and Compose then reads the key
   body as a variable name and refuses to deploy.
4. **Deploy.** The build runs `npm run typecheck`; the container then validates
   its environment, applies the committed migrations, and starts.
5. Open **Domains**, add a domain to the **controller** service:

   | Field | Value |
   |---|---|
   | Host | `api.example.com` |
   | Path | `/` |
   | Internal port | `8080` |
   | HTTPS | on (Let's Encrypt) |

   Do not add a domain to `postgres` or `redis`, and do not publish their ports.

Dokploy's generated Traefik labels handle TLS and routing. The controller sees
Traefik as one proxy hop, which is why the compose file ships
`TRUST_PROXY_HOPS=1` — rate limiting and node enrollment use the real client IP
from `X-Forwarded-For`.

### Verify it is alive

```bash
curl -fsS https://api.example.com/healthz    # process up
curl -fsS https://api.example.com/readyz     # Postgres + Redis reachable
curl -fsS https://api.example.com/api/v1/network/nodes/public-ips
```

The last one returns a signed (possibly empty) fleet list. Then open
`https://api.example.com/admin` — you should get the login page, not a 404.

If Traefik answers `502`, it is reaching nothing: check the domain's internal
port is `8080` and that the controller container is healthy in Dokploy's logs.

## 4. Create the admin account

Open the controller container's terminal in Dokploy (or run the equivalent on
the server) and seed once:

```bash
npm run db:seed -w apps/controller
```

It prints the admin email and a generated password — copy the password now. It
also prints the Ed25519 public key; confirm it matches the one you derived in
step 2.

To choose your own credentials and skip the development sample node:

```bash
SEED_ADMIN_EMAIL=you@example.com \
SEED_ADMIN_PASSWORD='a-long-password' \
SEED_SKIP_SAMPLE_NODE=true \
npm run db:seed -w apps/controller
```

Do **not** leave the seeded sample node enabled in production: it has no real
agent behind it. `SEED_SKIP_SAMPLE_NODE=true` avoids creating it; otherwise
delete it under **Nodes** after the first real node is online.

Log in at `https://api.example.com/admin`, change the seeded password, and give
each operator their own account (**Users → role**).

## 5. Add exit nodes

Each node is a separate Dokploy Compose service on its own VPS. Do not put the
node stack on the controller server unless you accept that the API and user
traffic share one IP and one failure domain.

1. In **Admin → Enrollments → Issue new**, choose a region (e.g. `eu-central`)
   and copy the one-time token. It is shown once and expires.
2. On the exit VPS, create a new Dokploy Compose service from this repository
   with compose path `docker-compose.dokploy-node.yml`.
3. Paste the node section of `.env.dokploy.example` into its environment and set
   `NODE_CONTROLLER_URL=https://api.example.com`, `NODE_ENROLLMENT_TOKEN`,
   `NODE_HOSTNAME` (the VPS's public hostname or IP), and `NODE_LABEL`.
4. Deploy. On first boot the agent exchanges the token for a permanent identity
   (node id, HMAC secret, REALITY keypair), stored in the `nodeidentity` volume.
5. The node appears under **Admin → Nodes** as `offline`, then `online` within
   about 30 seconds of its first heartbeat.
6. Remove `NODE_ENROLLMENT_TOKEN` from the environment and redeploy. The token
   is single-use; leaving it behind only risks it leaking.

The node detects its own public IP and reports it on every heartbeat. If the VPS
cannot reach an IP-echo service, set `NODE_PUBLIC_IP` explicitly. Private
addresses are refused, because allowlisting one would mean nothing.

Requirement: the VPS kernel must provide `/dev/net/tun`, and the container gets
`NET_ADMIN`. On a VPS where `/dev/net/tun` is missing, ask the provider to
enable TUN/TAP or use a different host.

## 6. Payments and email

Payments are optional; the platform runs without them and you can grant tiers
from **Users** in the meantime.

1. Set `OPENPAY_API_KEY` **and** `OPENPAY_WEBHOOK_SECRET` (both or neither —
   half-configured is refused at boot). Verify `OPENPAY_BASE_URL` is the real
   gateway, not the `example.com` placeholder.
2. Register the webhook at `https://api.example.com/webhooks/payments` for at
   least the events listed in [SETUP.md §6](../SETUP.md#6-take-payments-openpay).
3. Redeploy the controller.
4. In **Admin → Plans**, press **Create missing plans** once, then **Test
   connection**. A green key check does not guarantee the merchant account can
   charge; the panel reports the provider's own reason separately.
5. Buy the cheapest plan yourself and confirm it appears under **Payments** as
   applied. Entitlement comes from the verified webhook, not from the checkout
   redirect.

Outbound mail (password resets, lapse notices) is configured at
**Admin → Settings**, not in the environment. Save SMTP credentials, then
**Send test** to an address you can read.

## 7. Build and distribute the client

The client must be built with the controller's public URL and Ed25519 public
key, and it needs the native libbox engine to connect. Use the release workflow:

**Actions → client-release → Run workflow**, or:

```bash
gh workflow run client-release \
  -f controller_url=https://api.example.com \
  -f signing_public_key="$(openssl pkey -in signing-key.pem -pubout -outform DER | tail -c 32 | base64)" \
  -f signing_key_id=primary \
  -f libbox_ref=<40-character-reviewed-commit> \
  -f app_version=0.1.0 \
  -f app_build_number=1
```

Full setup, including the keystore secrets and how updates work, is in
[RELEASE-CLIENT.md](RELEASE-CLIENT.md).

Sanity checks before you hand the APK out: it installs, logs in, fetches a
server list, and connects. A build with the wrong public key fails closed with
"tampered configuration" — that is the signature working, not a network bug.

## 8. Operations

**Backups.** Back up three things: the Postgres volume (`pgdata`), the
Dokploy environment (`.env.dokploy`), and `signing-key.pem`. Dokploy can
schedule database backups; verify a restore once rather than trusting the
schedule.

Manual dump:

```bash
docker compose -f docker-compose.dokploy.yml exec -T postgres \
  pg_dump -U strict strict_proxy | gzip > "backup-$(date +%F).sql.gz"
```

**Upgrades.** Push to `main`, then **Redeploy** in Dokploy. Migrations run
automatically on boot and are idempotent. Node agents pick up controller-side
changes on their next sync; redeploy them only when the agent itself changed.

**Key rotation.** Rotating `JWT_SECRET` logs everyone out (harmless). Rotating
`SETTINGS_ENCRYPTION_KEY` makes the stored SMTP password unreadable — re-enter
it afterwards. Rotating the signing key invalidates every installed client;
only do it when you can ship new builds.

**Scaling.** One controller is intended. Additional capacity comes from adding
nodes, not controller replicas: the periodic sweep and rate limits assume a
single process, and there is no distributed lock.

## 9. Go-live checklist

- [ ] `https://api.example.com/readyz` returns 200 and `/admin` loads over HTTPS.
- [ ] `PUBLIC_APP_URL` is the real domain (a `localhost` value is refused at boot).
- [ ] `CORS_ORIGINS` is empty (mobile-only) or lists real origins — never `*`.
- [ ] All secrets are freshly generated; no `replace-*` value survives.
- [ ] `.env.dokploy` and `signing-key.pem` are backed up and not in git.
- [ ] The seeded admin password is changed and each operator has their own account.
- [ ] At least one real node is `online` and the sample node is deleted.
- [ ] A signed APK is built and one real purchase has been observed in **Payments**.
- [ ] A test password-reset email links to the real domain.
- [ ] A database restore has been tried once.

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Traefik returns 502 | domain points at the wrong service/port | domain on `controller`, internal port `8080`, container healthy |
| Deploy fails: `network dokploy-network ... not found` | Dokploy's shared network is missing | reinstall/repair Dokploy, or create `dokploy-network` manually |
| `refusing to boot with an unsafe production configuration` | `PUBLIC_APP_URL` is localhost, or `CORS_ORIGINS=*` | set the real domain / remove the wildcard |
| `required controller environment variable is missing` | variable absent or not in the service Environment tab | add it and redeploy |
| `unexpected character "/" in variable name "MC4CAQAw..."` | `SIGNING_PRIVATE_KEY_PEM` was pasted as a real multi-line PEM, so Compose parses the key body as a variable name | replace the whole block with the single-line value from step 2, quotes included, then redeploy |
| `database is not ready; retrying migration` then failure | password mismatch, or URL points at `localhost` | make `CONTROLLER_DATABASE_URL` use `postgres` and the same password |
| `/readyz` fails, `/healthz` passes | Redis unreachable | check `REDIS_PASSWORD` matches `CONTROLLER_REDIS_URL` |
| Node stays `offline` | cannot reach the controller, or enrollment failed | container logs on the node VPS; confirm `NODE_CONTROLLER_URL` is public HTTPS |
| Node enrollment token rejected | expired or already used | issue a new one (single-use, default 30 min) |
| Client says "tampered configuration" | client built with a different public key | rebuild with the current key and `SIGNING_KEY_ID` |
| Client connects to nothing / native SDK error | APK built without `libbox.aar` | use the release workflow, which refuses to build without it |
