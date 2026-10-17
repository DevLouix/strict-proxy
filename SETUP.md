# Setup and operations

Everything needed to stand this platform up, from a blank server to a working
proxy fleet, and to run it afterwards. No prior knowledge assumed.

If you only read one section, read [Quick path](#quick-path-15-minutes). If
something is broken, jump to [Troubleshooting](#troubleshooting).

---

## 1. What you are setting up

Four programs that talk to each other:

| Piece | Folder | What it does |
|---|---|---|
| **Controller** | `apps/controller` | The brain. Accounts, payments, node fleet, config bundles. HTTP API + the admin dashboard. |
| **Node (agent)** | `apps/node-agent` | One per VPS. Runs **sing-box** and serves user traffic. Calls home over a signed API. |
| **Client** | `apps/client` | The Flutter app a customer installs. Talks only to the controller. |
| **Gatekeeper** | `packages/gatekeeper` | Optional Express middleware for *your* web servers: admit only traffic from your nodes. |

You need **one** controller and **at least one** node. The client and gatekeeper
are optional depending on what you sell.

```
Customer app ──HTTP──► Controller ──signed list──► Gatekeeper (your servers)
                        │  ▲
       signed config ───┘  └─── signed webhooks ── payment provider
                        │
                        ▼
                  Node (sing-box) ──► internet
```

---

## 2. What you need before you start

### For the easy path (Docker)

- A Linux server (Debian/Ubuntu), **2 CPU / 2 GB RAM / 20 GB disk** is enough to
  start.
- **Docker** and the Compose plugin:
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"   # then log out and back in
  docker compose version            # must print a version
  ```
- A domain name pointing at the server (only needed for TLS / real payments).

### For the developer path (no Docker for the app)

- **Node.js 20 or newer** (`node --version`), plus `npm`.
- **PostgreSQL 16** and **Redis 7** running locally.
- Optional: **Flutter 3.x** if you are building the client.

> The controller refuses to start without `JWT_SECRET`,
> `SIGNING_PRIVATE_KEY_PEM` and `PAYMENT_WEBHOOK_SECRET`, and it checks them
> before doing anything else. That is deliberate — see
> `docker/validate-controller-env.sh`.

---

## 3. Quick path (15 minutes)

For trying it out on one machine, with no TLS, no real payments.

```bash
# 1. Get the code
git clone https://github.com/DevLouix/strict-proxy.git
cd strict-proxy

# 2. Start Postgres + Redis
docker compose up -d postgres redis

# 3. Install dependencies and generate secrets (.env is created for you)
npm install
npx tsx apps/controller/src/scripts/generate-env.ts

# 4. Load the secrets into your shell
set -a; source .env; set +a

# 5. Create the tables, then the admin user + a sample node
npm run db:migrate -w apps/controller
npm run db:seed -w apps/controller       # ← prints the admin password. Save it.

# 6. Run the controller
npm run dev:controller
```

Open **http://localhost:8080/admin**, log in with the email and password the seed
printed. You are now looking at the dashboard.

To try it with a real node, see [section 7](#7-add-your-first-node).

---

## 4. Production path (Docker)

Use this for anything that faces the internet.

### Step 1 — Get the code

```bash
git clone https://github.com/DevLouix/strict-proxy.git
cd strict-proxy
```

### Step 2 — Make your settings file

```bash
cp .env.docker.example .env.docker
```

`.env.docker` holds every secret and is **never committed** (it is gitignored).
Everything below is edited inside it.

### Step 3 — Generate the secrets

Run each command and paste the result into `.env.docker`.

To know which value goes where, the names match: `JWT_SECRET` in the output goes
into `JWT_SECRET` in the file.

```bash
# Database password (put the same value in POSTGRES_PASSWORD,
# CONTROLLER_DATABASE_URL and anywhere else it appears).
openssl rand -base64 32

# Redis password (POSTGRES_... is not involved; put it in REDIS_PASSWORD and
# CONTROLLER_REDIS_URL).
openssl rand -base64 32

# JWT_SECRET — must be at least 32 characters.
openssl rand -base64 48

# PAYMENT_WEBHOOK_SECRET — must be at least 32 characters.
openssl rand -base64 48

# SETTINGS_ENCRYPTION_KEY — encrypts the SMTP password in the database.
openssl rand -base64 32
```

The **Ed25519 signing key** is special: the controller signs config bundles with
it, and the client verifies them. Generate the key **and** the matching public
key in one go:

```bash
# Private key → paste into SIGNING_PRIVATE_KEY_PEM in .env.docker,
# with real newlines replaced by the two characters \n.
openssl genpkey -algorithm ed25519 -out signing-key.pem
awk 'BEGIN{ORS="\\n"} {print}' signing-key.pem

# Public key → this is what the CLIENT needs (STRICT_SIGNING_PUBLIC_KEY).
openssl pkey -in signing-key.pem -pubout -outform DER | tail -c 32 | base64

# Keep signing-key.pem somewhere safe and backed up.
```

> **Back up `signing-key.pem`.** Every client is pinned to its public half. Lose
> the private key and every installed client has to be rebuilt.

### Step 4 — Fill in the rest of `.env.docker`

Edit the file. The rows that matter:

| Setting | What to put |
|---|---|
| `POSTGRES_PASSWORD` | the database password from step 3 |
| `CONTROLLER_DATABASE_URL` | same password, e.g. `postgres://strict:<password>@postgres:5432/strict_proxy` |
| `REDIS_PASSWORD` | the redis password from step 3 |
| `CONTROLLER_REDIS_URL` | same password, e.g. `redis://:<password>@redis:6379` |
| `JWT_SECRET` | from step 3 |
| `SIGNING_PRIVATE_KEY_PEM` | from step 3, with `\n` escapes |
| `SIGNING_KEY_ID` | leave as `primary` unless you are rotating keys |
| `PAYMENT_WEBHOOK_SECRET` | from step 3 |
| `SETTINGS_ENCRYPTION_KEY` | from step 3 |
| `CORS_ORIGINS` | your client's web origin, or `*` while testing |
| `PUBLIC_APP_URL` | the public URL, e.g. `https://api.example.com`. Password-reset emails link here. |
| `CONTROLLER_BIND_ADDRESS` | keep `127.0.0.1` and put a TLS proxy in front |
| `ENABLE_HSTS` | `true` **only** once TLS is in front of the controller |

Leave `OPENPAY_*` empty for now (see [section 6](#6-take-payments-openpay)).

> Paying attention? `PUBLIC_APP_URL` and `SETTINGS_ENCRYPTION_KEY` are read by
> the controller and forwarded by `docker-compose.production.yml`. If you use
> your own compose file, forward them yourself — forgetting
> `SETTINGS_ENCRYPTION_KEY` makes secrets fall back to a JWT-derived key, and
> forgetting `PUBLIC_APP_URL` makes reset emails point at `localhost`.

### Step 5 — Check the file before you trust it

```bash
docker compose --env-file .env.docker -f docker-compose.production.yml config
```

This parses the whole file and prints the result. Any missing required value
fails here, before a container starts.

### Step 6 — Start it

```bash
docker compose --env-file .env.docker -f docker-compose.production.yml up -d --build
```

The controller container applies database migrations by itself on every boot
(idempotent), so there is no separate migration step.

Check it is healthy:

```bash
docker compose --env-file .env.docker -f docker-compose.production.yml ps
curl -fsS http://127.0.0.1:8080/healthz    # liveness
curl -fsS http://127.0.0.1:8080/readyz     # readiness (DB + Redis)
```

### Step 7 — Create your admin login

```bash
docker compose --env-file .env.docker -f docker-compose.production.yml \
  exec controller npm run db:seed -w apps/controller
```

It prints the admin email and a generated password — **copy the password now**.
It also prints the Ed25519 public key, which you need for the client.

To choose your own credentials and skip the development sample node:

```bash
docker compose --env-file .env.docker -f docker-compose.production.yml \
  exec -e SEED_ADMIN_EMAIL=you@example.com \
       -e SEED_ADMIN_PASSWORD='a-long-password' \
       -e SEED_SKIP_SAMPLE_NODE=true \
       controller npm run db:seed -w apps/controller
```

### Step 8 — Put TLS in front

The controller speaks plain HTTP and expects a reverse proxy to terminate TLS.
A ready-made Caddy profile is included:

```dotenv
# .env.docker
TLS_MODE=managed
CADDY_SITE_ADDRESS=https://api.example.com
```

```bash
docker compose --env-file .env.docker -f docker-compose.production.yml \
  --profile edge up -d --build
```

DNS must already point at the host and ports 80/443 must be reachable, or Caddy
cannot obtain a certificate.

Then open **https://api.example.com/admin**.

### Optional extras

```bash
# Run a node on this same host (see section 7 first)
docker compose --env-file .env.docker -f docker-compose.production.yml \
  --profile node up -d --build
```

---

## 5. A tour of the admin dashboard

Everything is at `/admin`. Log in with the admin account from step 7 of your
chosen path.

| Tab | What it is for |
|---|---|
| **Overview** | Counts: users, paying customers, nodes, credentials. Your "is it alive" page. |
| **Users** | Every account. Disable/enable, change role, and set a subscription's tier/status/expiry by hand. Disabling instantly kills that user's sessions and node credentials. |
| **Nodes** | The fleet. Health, load, region, and the buttons to drain, resume or delete a node. |
| **Enrollments** | One-time tokens used to add a new VPS. Issue, inspect, revoke. |
| **Payments** | Every verified payment event, with whether it was applied and why. This is where you find out why a purchase did not grant access. |
| **Usage** | Bandwidth per node. |
| **Plans** | What each tier costs, side by side: the price your catalog advertises and the price the provider will actually bill. Includes the **Change** control (section 8), and a **Payment gateway** panel that says whether the provider can take money right now and, if not, whether the fault is yours (a bad key) or the provider account's. |
| **Subscriptions** | Live subscriptions at the payment provider, and a cancel button. |
| **Settings** | Outbound email (SMTP). |

> The dashboard is plain HTML/CSS/JavaScript with no build step — what is in
> `apps/controller/src/admin/` is exactly what your browser runs.

---

## 6. Take payments (OpenPay)

Without a payment provider the platform still runs: it uses a built-in
placeholder that verifies a shared secret. You can hand-grant tiers from
**Users** in the meantime.

To take real money:

1. In the **OpenPay dashboard**, create an API key and a webhook signing secret.
2. Put them in your environment:

   ```dotenv
   OPENPAY_API_KEY=pk_live_...
   OPENPAY_BASE_URL=https://api.openpay.fiatden.com
   OPENPAY_WEBHOOK_SECRET=whsec_...
   OPENPAY_SIGNATURE_HEADER=x-webhook-signature-v1
   OPENPAY_TIMESTAMP_TOLERANCE_SECONDS=300
   OPENPAY_PLATFORM_NAME=StrictProxy
   ```

   Both must be set together. Setting one without the other is refused at boot,
   because webhooks could then never be verified.

3. Point OpenPay's webhook at `https://<your controller>/webhooks/payments`,
   subscribed to at least:

   ```
   charge.success
   charge.failed
   subscription.canceled
   subscription.payment_failed
   subscription.paused
   subscription.resumed
   dispute.created
   dispute.resolved
   ```

4. Restart the controller.
5. In **Plans**, press **Create missing plans** once. This creates the provider
   plan each tier needs.
6. Check the health of the wiring:

   ```bash
   curl -fsS https://<your controller>/healthz
   ```

   Then buy a cheap plan yourself and watch it appear under **Payments**. If the
   event shows as not applied, the reason is written next to it.

### Prices

`STANDARD_TIER_AMOUNT_MINOR` and `PRO_TIER_AMOUNT_MINOR` are **minor units** —
kobo, cents. `250000` with `BILLING_CURRENCY=NGN` is ₦2,500.00. They are the
deployment defaults; section 8 changes them without a redeploy.

---

## 7. Add your first node

A node is a VPS that carries traffic. You are never touching the controller's
database by hand.

### Step 1 — Issue a one-time token

**Dashboard → Enrollments → Issue new.** Choose a region (for example
`eu-central`), an optional label, and a lifetime. Copy the token — **it is shown
once**.

Or, with curl:

```bash
curl -X POST https://<your controller>/api/v1/admin/node-enrollments \
  -H "authorization: Bearer <admin access token>" \
  -H 'content-type: application/json' \
  -d '{"region":"eu-central","label":"Frankfurt 1","ttlMinutes":30}'
```

### Step 2 — Install the agent on the VPS

```bash
sudo CONTROLLER_URL=https://<your controller> \
     NODE_ENROLLMENT_TOKEN='<the token you just copied>' \
     NODE_HOSTNAME='fra-1.example.com' \
     NODE_LABEL='Frankfurt 1' \
     bash apps/node-agent/deploy/install-node.sh
```

You do **not** need to know the VPS's IP. The agent finds it on its own (it asks
an IP-echo service, by default `https://api.ipify.org`) and reports it; if that
ever fails, the controller falls back to the address the node enrolled from.
Leave `NODE_PUBLIC_IP` unset and this all happens by itself. Pin it only if the
VPS cannot reach the internet on the way out.

On first boot the agent exchanges the token for its permanent identity (node id,
HMAC secret, REALITY keypair) and saves it at
`/etc/strict-proxy/node-identity.json`, readable only by root. The token is then
useless and should be removed:

```bash
sudo sed -i '/NODE_ENROLLMENT_TOKEN/d' /etc/strict-proxy/agent.env
sudo systemctl restart strict-proxy-agent
```

### Step 3 — Watch it come online

The node starts as `offline` and flips to `online` after its first heartbeat
(within ~30 seconds). It appears under **Nodes**, and inside the next config
bundle the client fetches.

If it does not appear, see [Troubleshooting](#troubleshooting).

### How the "trusted IP" list looks after itself

Your origins only accept traffic from your fleet. That list is not a file you
edit — it is built live from the nodes that are `online` or `degraded`:

- a node that comes online **adds itself**;
- a node that goes offline **removes itself**;
- a node whose public IP changes **updates itself** on the next heartbeat, so a
  provider re-addressing a VPS cannot silently leave you allowlisting an address
  you no longer control.

What still needs a human is the one-time enrollment token. That is deliberate:
without it, anyone who starts a machine on your network could add their IP to the
list your origins trust. Minting the token is one click.

The controller refuses to store a private address (loopback, `10.x`, `192.168.x`,
`172.16–31.x`, link-local, CGNAT) as a node's public IP, because such a value
would allowlist something meaningless. Under **Nodes**, an address that moved on
its own is labelled **auto-detected**, and one you edited is labelled **set by
admin**.

> **Automatic IP updates can be turned off.** Set `NODE_IP_AUTODETECT=false` in
> the controller environment and nodes can no longer move their own allowlist
> entry; an admin must edit the node instead. The default is on, which is what
> makes a re-addressed VPS heal itself.

---

## 8. Change what a plan costs

The **Plans** tab shows two numbers per tier:

- **Catalog** — what your own app advertises, and what a one-off checkout charges.
- **Provider** — what the payment provider will actually bill a subscription against.

These must agree. **Change** updates both, in one action.

1. **Plans → Change** on the tier you want.
2. Type the new amount in **major units** (e.g. `2500` for ₦2,500.00) and Save.
3. If a plan exists, the provider is updated first. If that fails, nothing
   changes — you will not end up advertising a price you cannot bill.
4. If the tier has no sellable plan yet, the message tells you to press
   **Create missing plans**. Do that, and the plan is created at the new price.

**Reset** puts a tier back to the price configured in your environment.

> **Read this before changing a live price.** The new price certainly applies to
> *new* customers. Whether OpenPay re-prices a subscription that is *already
> running* — or keeps the amount it started with — is the provider's behaviour
> and cannot be checked from here. Confirm it with OpenPay before relying on it.

A price shown as **price drift** means the catalog and the provider disagree.
Nothing changes it automatically: repricing a live plan silently would change
what existing subscribers are billed. Use **Change** when you mean it.

---

## 9. Configure outbound email

Reset links and expiry notices need a mail server. Configure it in the dashboard,
not the environment, so credentials can be rotated without a deploy.

**Settings** needs:

| Field | Example |
|---|---|
| Host | `smtp.example.com` |
| Port | `587` (or `465` with TLS) |
| Username | `mailer@example.com` |
| Password | *write-only — entered, never read back* |
| From address | `no-reply@example.com` |
| Secure | on for port 465 |

Press **Save**, then **Send test** to an address you can read.

The password is stored encrypted (AES-256-GCM under `SETTINGS_ENCRYPTION_KEY`).
If you rotate `SETTINGS_ENCRYPTION_KEY`, re-enter the password — it becomes
unreadable and outbound mail stops until you do.

There is also a bulk **lapse notices** endpoint
(`POST /api/v1/admin/billing/lapse-notices`) for emailing customers whose
subscription has expired. It has no dashboard button yet; call it directly.

---

## 10. Build the client app

```bash
cd apps/client

# 1. Generate the host projects (they are gitignored, so this is always needed)
flutter create --platforms=linux,android,ios .

# 2. Dependencies
flutter pub get

# 3. Build, pointing at your controller and your signing key
flutter build apk --release \
  --dart-define=STRICT_ENV=production \
  --dart-define=STRICT_CONTROLLER_URL=https://api.example.com \
  --dart-define=STRICT_SIGNING_PUBLIC_KEY='<public key from step 3>' \
  --dart-define=STRICT_SIGNING_KEY_ID=primary
```

Linux and iOS builds use the same `--dart-define` values with
`flutter build linux --release` or `flutter build ios --release`.

**There are no secrets in these values.** They are compiled into a binary anyone
can inspect, so the public key is *public* by design — it only lets the client
*verify* bundles, never sign them.

In a production build a missing signing key is a **hard failure**: the client
refuses to connect rather than run unverified. That is intentional.

---

## 11. Everyday operations

Almost everything is a button in `/admin`. The rest:

```bash
cd strict-proxy

# --- containers ---------------------------------------------------------
docker compose --env-file .env.docker -f docker-compose.production.yml ps
docker compose --env-file .env.docker -f docker-compose.production.yml logs -f controller
docker compose --env-file .env.docker -f docker-compose.production.yml restart controller
docker compose --env-file .env.docker -f docker-compose.production.yml down

# --- is it alive? -------------------------------------------------------
curl -fsS http://127.0.0.1:8080/healthz   # process is up
curl -fsS http://127.0.0.1:8080/readyz    # database + cache are up too

# --- common admin jobs (needs an admin access token) --------------------
TOKEN='<admin access token>'
curl -sS http://127.0.0.1:8080/api/v1/admin/overview       -H "authorization: Bearer $TOKEN"
curl -sS http://127.0.0.1:8080/api/v1/admin/nodes          -H "authorization: Bearer $TOKEN"
curl -sS http://127.0.0.1:8080/api/v1/admin/payments/events -H "authorization: Bearer $TOKEN"
curl -sS http://127.0.0.1:8080/api/v1/admin/billing/plans  -H "authorization: Bearer $TOKEN"

# Refund a settled checkout (a full refund revokes access)
curl -X POST http://127.0.0.1:8080/api/v1/admin/billing/refund \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"reference":"<checkout reference>"}'
```

### Dashboard coverage

Every operator route has a button **except** these, which are call-only:

| Route | Why |
|---|---|
| `GET /api/v1/admin/disputes…` + evidence submission | no disputes view yet; the API is complete, so evidence can still be filed before the provider's deadline |
| `POST /api/v1/admin/billing/refund` | refunds are deliberately a manual decision |
| `POST /api/v1/admin/billing/lapse-notices` | a bulk mailing action |
| `POST /api/v1/admin/users/:userId/password-reset` and `…/email` | the Settings tab links to the flow; per-user buttons are not wired |
| `POST /api/v1/admin/nodes` | the dashboard uses the enrollment-token flow instead |

### Backups

Two things matter:

```bash
# 1. The database
docker compose --env-file .env.docker -f docker-compose.production.yml \
  exec -T postgres pg_dump -U strict strict_proxy | gzip > "backup-$(date +%F).sql.gz"

# 2. Your secrets — .env.docker AND signing-key.pem
```

The signing key is not in the database. Without it you cannot sign bundles for
already-installed clients.

### Upgrading

```bash
git pull
docker compose --env-file .env.docker -f docker-compose.production.yml up -d --build
```

Migrations run automatically on boot, in order, once each. There is no manual
migration step and no need to stop anything first.

---

## 12. Security checklist

Before you call it done:

- [ ] `JWT_SECRET`, `PAYMENT_WEBHOOK_SECRET` and `SETTINGS_ENCRYPTION_KEY` are
      all freshly generated, and none of them is still a placeholder.
- [ ] `.env.docker` and `signing-key.pem` are outside version control, with
      file permissions `600`.
- [ ] `CONTROLLER_BIND_ADDRESS` is `127.0.0.1` and TLS terminates in front.
- [ ] `ENABLE_HSTS=true` — **only** after TLS works.
- [ ] Postgres and Redis are bound to `127.0.0.1`, never `0.0.0.0`.
- [ ] `CORS_ORIGINS` names your real origin rather than `*`.
- [ ] The admin password from the seed has been changed, and each operator has
      their own account (**Users → change role**).
- [ ] Backups run *and* have been restored once successfully.
- [ ] You have paid OpenPay's own merchant security a thought: an account API
      key plus a webhook secret are enough to take payments, so treat both as
      passwords.

Rotating the JWT secret logs everyone out (harmless). Rotating
`SETTINGS_ENCRYPTION_KEY` invalidates stored provider credentials — re-enter the
SMTP password afterwards. Rotating the signing key invalidates **every installed
client**; only do it if you can ship new builds.

---

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `required controller environment variable is missing: JWT_SECRET` at boot | `.env.docker` not filled in, or not passed to compose | complete step 3–4 and always pass `--env-file .env.docker` |
| `JWT_SECRET must contain at least 32 characters` | generated value too short | regenerate with `openssl rand -base64 48` |
| `database is not ready; retrying migration` then failure | wrong Postgres password, or `postgres` is not healthy | check `POSTGRES_PASSWORD` matches `CONTROLLER_DATABASE_URL`; `docker compose … ps` |
| `/readyz` fails while `/healthz` passes | Redis is unreachable | check `REDIS_PASSWORD` matches `CONTROLLER_REDIS_URL` |
| Dashboard is a blank page | a JavaScript module 404'd | hard-refresh; check the browser console and `… logs controller` |
| Logged out of the dashboard immediately | the controller answered `401`/`403` | your session expired; log in again. Anything else is a bug. |
| Payments show as **not applied** | provider event did not match a checkout | open **Payments** — the reason is listed per event |
| `OPENPAY_API_KEY is set but OPENPAY_WEBHOOK_SECRET is empty` | half-configured gateway | set both, or neither |
| Node stays `offline` | agent cannot reach the controller, or enrollment failed | `journalctl -u strict-proxy-agent -n 100` on the VPS |
| Enrollment says "could not determine a public IP" | the VPS could not reach the IP-echo service, so set `NODE_PUBLIC_IP` explicitly | set `NODE_PUBLIC_IP=<vps public ip>` in `agent.env` and restart |
| Node enrollment token rejected | expired (default 30 min) or already used | issue a new one — they are single-use and time-limited |
| Client shows "tampered configuration" | signing key mismatch between controller and client build | rebuild the client with the controller's current public key and `SIGNING_KEY_ID` |
| Client refuses to connect before login | production build with no signing key | rebuild with `STRICT_SIGNING_PUBLIC_KEY`; this is intentional |
| Password-reset email links to `localhost` | `PUBLIC_APP_URL` not set (and, in Docker, not forwarded) | set it in `.env.docker` and restart |
| Outbound email stopped after a key rotation | stored SMTP password was encrypted with the old `SETTINGS_ENCRYPTION_KEY` | re-enter the password in **Settings** |
| A plan shows **price drift** | catalog price and provider plan disagree | use **Change** when you mean to reprice |
| Customer paid but has no access | webhook never arrived, or was rejected | **Payments** shows verified events; check the provider's delivery log and the webhook secret |
| Card payments fail with a provider error ("no active channel", "credential rejected") | the payment account cannot take money, or your key is wrong | **Plans → Payment gateway** tells the two apart and shows the provider's own "what to do" text |

### Getting more detail

```bash
docker compose --env-file .env.docker -f docker-compose.production.yml logs -f controller
docker compose --env-file .env.docker -f docker-compose.production.yml logs -f node-agent
```

Every log line from the controller is JSON with a request id, which is also
returned in the `x-request-id` response header — quote it when asking for help.

### Before you ask for help

```bash
# From the repository root:
npm run typecheck          # types are consistent
npm test                   # the whole suite (needs Docker, for test databases)
docker compose --env-file .env.docker -f docker-compose.production.yml config
```

---

## 14. Appendix: run it as a developer

Same as the [quick path](#quick-path-15-minutes), with the details.

```bash
# Infrastructure only — the app runs on your machine, not in a container
docker compose up -d postgres redis

npm install
npx tsx apps/controller/src/scripts/generate-env.ts   # writes .env once, never overwrites
set -a; source .env; set +a

npm run db:migrate -w apps/controller     # apply apps/controller/drizzle/*.sql
npm run db:seed -w apps/controller        # admin + sample node; prints password + public key

npm run dev:controller                    # hot-reloading controller on :8080
```

Handy scripts:

| Command | Does |
|---|---|
| `npm run dev:controller` | controller with reload |
| `npm run dev:agent` | node agent locally |
| `npm test` | unit + integration suites (spins up its own databases) |
| `npm run test:unit` | unit tests only |
| `npm run test:integration` | integration tests only |
| `npm run typecheck` | type-check every workspace |
| `npm run db:migrate -w apps/controller` | apply migrations |
| `npm run db:seed -w apps/controller` | create an admin and a sample node |
| `npm run server:prereqs` | check a fresh server has everything |
| `npm run server:smoke` | end-to-end smoke test against a running controller |
| `npm run docker:config` | validate `.env.docker` + compose without starting |

The integration suite expects Docker: it creates throwaway Postgres and Redis
containers per run, so nothing you care about is touched.

### Where to look next

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how each module works, the
  trust boundaries, which payment-provider features are used and which are
  deliberately ignored, and the honest list of what is still open.
- [`README.md`](README.md) — the API surface and the security model.
- `apps/client/README.md` — client build flags and bundle verification.
