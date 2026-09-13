# strict-proxy

An advanced proxy suite for internal strict access — a fully sovereign, self-hosted
proxy/VPN + access-control platform with four decoupled modules:

| Module | Location | Stack |
|---|---|---|
| **Central Controller** (the brain) | `apps/controller` | Node.js + TypeScript, Express, Drizzle/Postgres, Redis |
| **Global Node Fleet** (exit nodes) | `apps/node-agent` | TypeScript agent + sing-box (VLESS + REALITY), systemd |
| **Custom Client App** | `apps/client` | Flutter, native `strict_proxy/libbox` platform channel |
| **Gatekeeper SDK** (access control) | `packages/gatekeeper` | Express middleware, Ed25519-verified fleet IP allowlist |

Shared primitives live in `packages/types` (domain types, HMAC + Ed25519 helpers,
REALITY keygen, strict env parsing).

## Architecture

```
Payment Gateway ──(signed webhook)──┐
                                    ▼
Flutter Client ◄──JWT/refresh──► Central Controller ──(Ed25519-signed lists)──► Gatekeeper SDK
    │                             (Postgres, Redis)                                    ▲
    └──dynamic sing-box JSON────► Fleet Nodes (sing-box) ──(HMAC internal API)────────┘
                                       │ user traffic egresses from NODE IP
                                       ▼
                               Gatekeeper-protected origins admit only fleet IPs
```

## Quick start (local)

```bash
# 1. Infrastructure
docker compose up -d postgres redis

# 2. Install + generate secrets (.env is auto-created, never committed)
npm install
npx tsx apps/controller/src/scripts/generate-env.ts
set -a; source .env; set +a

# 3. Schema + seed (prints admin password and creates a development sample node)
npm run db:push -w apps/controller
npm run db:seed -w apps/controller

# 4. Run the controller
npm run dev:controller
```

### Node fleet enrollment (multi-VPS)

Each VPS is assigned a location by the admin and enrolls itself with a one-time token.
The token is short-lived, stored only as a hash, consumed atomically, and never becomes
the node's long-term credential.

1. Log in as an admin and create an enrollment:

```http
POST /api/v1/admin/node-enrollments
Authorization: Bearer <admin-access-token>
Content-Type: application/json

{"region":"eu-central","label":"Frankfurt 1","ttlMinutes":30}
```

2. On the target Debian/Ubuntu VPS, install the agent and set the returned token:

```bash
sudo CONTROLLER_URL=https://controller.example.com \
  NODE_ENROLLMENT_TOKEN='<one-time-token>' \
  NODE_PUBLIC_IP='<vps-public-ip>' \
  NODE_HOSTNAME='fra-1.example.com' \
  NODE_LABEL='Frankfurt 1' \
  bash apps/node-agent/deploy/install-node.sh
```

3. Deploy the built `apps/node-agent` files and the systemd units, then start the
agent. On first boot it calls `POST /api/v1/nodes/enroll`, receives a node id,
HMAC secret, and controller-generated REALITY keypair, and saves the identity at
`/etc/strict-proxy/node-identity.json` with mode `0600`. Remove the enrollment token
from `agent.env` after the first successful enrollment.

The node starts `offline`, becomes `online` after a valid HMAC heartbeat, and then
appears automatically in the client config bundle. Its `region`, `label`, load,
status, public IP, and latency target are shown in the client server selector.

Admin fleet controls are global: list nodes, inspect health, change lifecycle state,
edit location/label/public endpoint, drain/offline a node, delete a node, create/list/
revoke enrollment tokens, and inspect payment events.

```ts
import { createGatekeeperMiddleware } from '@strict-proxy/gatekeeper';

app.use(createGatekeeperMiddleware({
  controllerBaseUrl: process.env.CONTROLLER_URL!,
  publicKeys: { primary: process.env.GATEKEEPER_PUBLIC_KEY_PEM! }, // controller's Ed25519 public key
  cacheTtlSeconds: 300,        // cached fleet IP list
  trustForwardedFor: true,     // only behind a trusted reverse proxy
  failureMode: 'closed',       // controller down => deny
}));
// Non-fleet clients now receive 403 GATEKEEPER_DENIED (customizable).
```

## API surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/v1/auth/register` / `login` / `refresh` / `logout` | none / JWT | Accounts + device-seat-limited tokens |
| `GET /api/v1/me` | JWT | Profile + device seats |
| `GET /api/v1/network/config` | JWT + active sub | Signed dynamic VLESS+REALITY bundle per user |
| `GET /api/v1/network/nodes/public-ips` | public (signed) | Ed25519-signed fleet IP list for Gatekeeper |
| `POST /api/v1/admin/node-enrollments` | admin JWT | Create a one-time enrollment token scoped to a region |
| `GET /api/v1/admin/node-enrollments` / `DELETE .../:id` | admin JWT | Audit/revoke enrollment tokens |
| `POST /api/v1/nodes/enroll` | one-time token | Self-register a VPS and receive its HMAC identity |
| `GET /api/v1/admin/nodes` / `PATCH .../:id` / `DELETE .../:id` | admin JWT | Global fleet management and lifecycle controls |
| `POST /webhooks/payments` | webhook HMAC | `checkout.completed` grants tier; `subscription.deleted` / `invoice.payment_failed` revoke instantly |
| `GET /internal/v1/node/bootstrap` | node HMAC | REALITY keys + node settings |
| `POST /internal/v1/node/heartbeat` | node HMAC | Load/health reporting |
| `GET /internal/v1/node/sync` | node HMAC | Desired credential state (UUID + short-id) |
| `POST /internal/v1/node/usage` | node HMAC | Per-credential bandwidth rollups |

## Security model

- **Zero Trust**: nodes authenticate with HMAC-SHA256 (method+path+timestamp+nonce+body-hash),
  single-use nonces via Redis, timestamp tolerance window; no raw node admin access.
- **Clients** get short-lived JWTs bound to devices; refresh tokens are single-use,
  stored hashed; logout inserts the access token's JTI into a revocation list.
- **Payments**: idempotent event ledger (`payment_events` PK + Redis fast-path);
  revocation events drop refresh tokens and revoke all VLESS credentials immediately
  (nodes converge on the next sync tick).
- **Public artifacts** (config bundles, IP lists) are Ed25519-signed over canonical
  JSON with key-id support for rotation; the Gatekeeper refuses unknown/expired/tampered lists.

## Admin control plane

The controller includes an authenticated admin REST surface. The seeded admin logs in
through the same JWT flow and receives `role: admin`; every admin route requires both
that JWT and the admin role.

| Route | Purpose |
|---|---|
| `GET /api/v1/admin/overview` | Fleet, user, subscription and credential counts |
| `GET /api/v1/admin/users` | List users and subscription state |
| `PATCH /api/v1/admin/users/:userId` | Disable/enable a user or change role |
| `PATCH /api/v1/admin/users/:userId/subscription` | Set tier, status and expiration; revokes access when inactive |
| `GET /api/v1/admin/nodes` | Inspect fleet health and heartbeat state |
| `POST /api/v1/admin/node-enrollments` | Issue a one-time, region-scoped VPS enrollment token |
| `GET /api/v1/admin/node-enrollments` / `DELETE .../:id` | Audit or revoke enrollment tokens |
| `PATCH /api/v1/admin/nodes/:nodeId` / `DELETE .../:nodeId` | Edit, drain, disable, or remove a node |
| `GET /api/v1/admin/payments/events` | Audit verified payment events and outcomes |

This repository does not yet contain a separate web admin dashboard; these APIs are the
backend control plane for an admin UI or operational tooling.

## Usage accounting

The node agent enables sing-box's V2Ray API statistics service on loopback and queries
per-user counters using the local gRPC API. It reports reset counter windows to the
controller; usage rollups have a unique `(credential, windowStart, windowEnd)` key so
retries do not double-count. The deployed sing-box binary must include the V2Ray API
feature/tag, and the agent must be able to read `src/v2rayapi/stats.proto`.

## Payments: integration point

The gateway is intentionally **not called** anywhere. Implement
`PaymentGatewayAdapter` (see `apps/controller/src/services/payments.ts`) —
`verifyWebhook()` + `parseEvent()` — and mount
`createPaymentWebhookRouter({ adapter })`. Everything downstream
(tier grants, period extension, immediate revocation, idempotency) already works
and is covered by the flows exercised in this repo's smoke tests.

## Flutter client

The client is built and tested separately from the server. Linux uses the installed
`sing-box` CLI; Android uses the native libbox bridge and requires the generated
`libbox.aar` for a real VPN session. Unsupported platforms fail closed instead of
silently using a fake engine.

Install the Linux/Android development prerequisites on Debian/Ubuntu:

```bash
./apps/client/tool/setup-linux.sh
```

For local development:

```bash
cd apps/client
flutter run \
  --dart-define=STRICT_ENV=development \
  --dart-define=STRICT_CONTROLLER_URL=http://10.0.2.2:8080
```

Production builds must use HTTPS and can tune request/TUN settings without source
changes:

```bash
flutter build apk --release \
  --dart-define=STRICT_ENV=production \
  --dart-define=STRICT_CONTROLLER_URL=https://api.example.com \
  --dart-define=STRICT_REQUEST_TIMEOUT_SECONDS=15
```

Run client verification locally:

```bash
./apps/client/tool/verify-linux-android.sh
```

This generates the Flutter Linux/Android host projects, runs tests and analysis,
and builds both targets. Linux runtime additionally requires an installed
`sing-box` binary (`STRICT_SING_BOX_BIN=/absolute/path/to/sing-box`). Android APK
compilation does not require `libbox.aar`, but connecting a VPN does. Build the
native artifact from a reviewed immutable upstream commit with:

```bash
export SING_BOX_LIBBOX_REF=<40-character-reviewed-commit-sha>
./apps/client/tool/build-libbox.sh
```

`.github/workflows/client-linux-android.yml` runs tests and analysis for client
changes. On pushes to `main` and `release/*`, it also uploads versioned Linux and
Android build artifacts. The workflow intentionally does not publish client
binaries for pull requests or development branches.

The Android host project is generated because it is intentionally not committed:

```bash
cd apps/client
flutter create --platforms=android,linux .
```

The Android bridge requests VPN permission, starts the foreground service, and
reports native failures back to the UI; it never claims a connection when the
libbox artifact or VPN permission is unavailable.


## Docker server deployment

The repository includes an environment-driven Compose stack for the controller,
Postgres, Redis, an optional Caddy edge, and an optional TUN-capable node agent.
Copy the template and replace every placeholder before starting:

```bash
cp .env.docker.example .env.docker
# Set CONTROLLER_DATABASE_URL and CONTROLLER_REDIS_URL to the Docker service URLs.
# Generate strong secrets; do not use the example values.
docker compose --env-file .env.docker -f docker-compose.production.yml config
docker compose --env-file .env.docker -f docker-compose.production.yml up -d --build
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/readyz
```

`CONTROLLER_DATABASE_URL` and `CONTROLLER_REDIS_URL` are explicit because
`localhost` inside a container means that container itself. Use `postgres` and
`redis` service names for the normal bridge deployment. The backend subnet defaults
to `172.30.0.0/16` and is configurable with `BACKEND_NETWORK_SUBNET` and
`BACKEND_NETWORK_GATEWAY`; select a non-overlapping RFC1918 range on each host.

The controller starts only after its Postgres and Redis dependencies are healthy,
validates the JWT/webhook/signing secrets, applies the Drizzle schema, and exposes
`/readyz` only when both dependencies respond. Redis requires `REDIS_PASSWORD` and
is bound to localhost by default. Postgres and Redis data, container resource
limits, restart policies, host bindings, ports, log rotation, CORS, proxy hops,
HSTS, image names, and network settings are all environment-controlled.

### HTTPS edge

For local testing, leave `TLS_MODE=disabled`. To enable Caddy-managed HTTPS in a
real deployment:

```dotenv
TLS_MODE=managed
CADDY_SITE_ADDRESS=https://api.example.com
TLS_EMAIL=ops@example.com
EDGE_HTTP_PORT=80
EDGE_HTTPS_PORT=443
```

Ensure DNS for `api.example.com` points to this host and inbound TCP ports 80 and
443 are reachable, then run:

```bash
docker compose --profile edge --env-file .env.docker \\
  -f docker-compose.production.yml up -d --build
```

Caddy persists certificates in the configured data volume. It refuses managed mode
unless the site address uses `https://`, and disabled mode never requests an ACME
certificate. Put the edge in front of the controller before exposing the API and
set `CORS_ORIGINS` to the actual client origins rather than `*`.

### Docker node agent

The node profile requires a Linux host with `/dev/net/tun` and `NET_ADMIN`:

```bash
docker compose --profile node --env-file .env.docker \\
  -f docker-compose.production.yml up -d --build
```

On first boot provide `NODE_ENROLLMENT_TOKEN`, `NODE_PUBLIC_IP`, and
`NODE_HOSTNAME`. The node image contains Node 22, the agent dependencies, and the
pinned sing-box release. It runs sing-box in managed mode because Docker does not
provide systemd; node identity persists in `NODE_IDENTITY_VOLUME`. The entrypoint
fails closed when enrollment or the public endpoint is missing. Run one node-agent
container per VPS with a unique enrollment token; do not expose its stats listener.

### CI, artifacts, and live smoke test

`.github/workflows/server-ci.yml` validates the server on pull requests. Pushes to
`main` and `release/*` build and publish the controller and node-agent images to
GHCR, and upload a versioned node-agent deployment archive. The image build pins
sing-box with `SING_BOX_VERSION`.

After starting a deployment, run the repeatable API smoke test:

```bash
BASE_URL=https://api.example.com scripts/smoke-server.sh
```

It checks health/readiness, registration, login, JWT-protected access, unauthenticated
denial, and signed public-IP output. The repository also contains
`docker-compose.live-test.yml`, a host-network override for restricted Linux
sandboxes; it is for isolated testing only and must not be used as production
network policy.

```bash
npx tsx scripts/smoke-gatekeeper.ts   # controller + Gatekeeper end-to-end
```

Covers: register/login, signed config bundle, payment webhook (bad + good signature,
tier grant), public-ips signing, Gatekeeper deny (403) / allow (200).

## Development

```bash
npm run typecheck   # all TS packages
npm run dev:controller
npm run dev:agent   # requires agent env vars
```
