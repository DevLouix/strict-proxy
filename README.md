# strict-proxy

An advanced proxy suite for internal strict access — a fully sovereign, self-hosted
proxy/VPN + access-control platform with four decoupled modules:

| Module | Location | Stack |
|---|---|---|
| **Central Controller** (the brain) | `apps/controller` | Node.js + TypeScript, Express, Drizzle/Postgres, Redis |
| **Global Node Fleet** (exit nodes) | `apps/node-agent` | TypeScript agent + sing-box (VLESS + REALITY), systemd |
| **Custom Client App** | `apps/client` | Flutter, sing-box via `libbox` (adapter pattern, stubbed) |
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

# 3. Schema + seed (prints admin password, node id, NODE_HMAC_SECRET)
npm run db:push -w apps/controller
npm run db:seed -w apps/controller

# 4. Run the controller
npm run dev:controller
```

### Node agent (on each VPS)

```bash
cp apps/node-agent/deploy/agent.env.example /etc/strict-proxy/agent.env
# fill NODE_ID + NODE_HMAC_SECRET from registration, then:
sudo cp apps/node-agent/deploy/strict-proxy-agent.service /etc/systemd/system/
sudo cp apps/node-agent/deploy/sing-box.service /etc/systemd/system/
sudo systemctl enable --now strict-proxy-agent sing-box
```

The agent bootstraps REALITY keys from the controller, heartbeats load, and
converges local sing-box users to the controller's credential state (fingerprinted
restarts only on real change).

### Gatekeeper SDK (drop into any Express app)

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

## Payments: integration point

The gateway is intentionally **not called** anywhere. Implement
`PaymentGatewayAdapter` (see `apps/controller/src/services/payments.ts`) —
`verifyWebhook()` + `parseEvent()` — and mount
`createPaymentWebhookRouter({ adapter })`. Everything downstream
(tier grants, period extension, immediate revocation, idempotency) already works
and is covered by the flows exercised in this repo's smoke tests.

## Flutter client

```bash
cd apps/client
flutter pub get
flutter run --dart-define=STRICT_CONTROLLER_URL=http://10.0.2.2:8080
```

Custom UI (login/register, connect toggle, live-latency server picker) is complete;
the engine is abstracted behind `VpnEngine` (`lib/features/engine/engine_adapter.dart`).
`NoopEngine` simulates sessions for dev; `LibboxEngine` marks the exact libbox
integration points (TUN service + box start/stop) to wire when the gomobile plugin is added.

## Verified smoke tests

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
