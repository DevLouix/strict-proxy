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

> **New here?** Read [`SETUP.md`](SETUP.md) to get a working deployment step by
> step, then [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —
> it maps every module, the trust boundaries, the data model, which of the
> OpenPay SDK's 32 resources we deliberately do *not* use, and an explicit list
> of known gaps.

## Download the app

Every green build of `main` publishes the signed Android APK and the Linux bundle
to [the latest release](https://github.com/DevLouix/strict-proxy/releases/latest):

- Android: `strict-proxy-client-android-<commit>.apk` — signed release build, no
  debug key, install with `adb install -r <file>.apk`.
- Linux: `strict-proxy-client-linux-<commit>.tar.gz` — unpack and run the
  `strict_proxy_client` executable.

The APK has the controller URL compiled in, so a build from `main` talks to the
controller the `CLIENT_CONTROLLER_URL` repository variable names. The repository
is private, so the release page and its assets need a signed-in GitHub account;
see [`docs/RELEASE-CLIENT.md`](docs/RELEASE-CLIENT.md) for the versioned
`client-release` flow instead.

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
npm run db:migrate -w apps/controller   # applies apps/controller/drizzle/*.sql
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
  NODE_HOSTNAME='fra-1.example.com' \
  NODE_LABEL='Frankfurt 1' \
  bash apps/node-agent/deploy/install-node.sh
```

`NODE_PUBLIC_IP` is optional: when it is omitted the agent detects the VPS's own
public address and reports it, and the controller uses the address the node
enrolled from if detection is unavailable. Pin it only when the VPS has no
outbound access to an IP-echo service.

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
  requiredTier: 'pro',         // omit for fleet-only; 'standard' also admits pro
}));
// Non-fleet clients receive 403 GATEKEEPER_DENIED. Fleet clients without a
// valid plan receive 401/403 GATEKEEPER_ENTITLEMENT_* / TIER_INSUFFICIENT.
```

The client fetches a short-lived token from `GET /api/v1/entitlement` with its
access token and sends it as `x-strict-proxy-entitlement`:

```ts
const { token } = await fetch(`${CONTROLLER}/api/v1/entitlement`, {
  headers: { authorization: `Bearer ${accessToken}` },
}).then((r) => r.json());
await fetch('https://pro-only.example.com/api', {
  headers: { 'x-strict-proxy-entitlement': token },
});
```

The Gatekeeper verifies the Ed25519 signature offline, then applies the plan
hierarchy: a `standard` site admits `standard` and `pro`; a `pro` site admits
only `pro`; `free` and lapsed plans are refused. Tokens default to five minutes
(`ENTITLEMENT_TOKEN_TTL_SECONDS`, 60–900), so a cancellation takes effect within
one token lifetime even without a controller call. On success the verified
identity is available to the site as `req.strictProxy` (`userId`, `email`, `tier`).

A browser following a link cannot set a header, so the same token is also read
from `?sp_ticket=<token>` (what the client's Links screen opens) and from the
`sp_entitlement` cookie. Both are short-lived bearer credentials and neither
replaces the fleet-IP check.

### Links, published by plan

An operator gates a site with the Gatekeeper, then publishes it from **Admin →
Links** with the same `requiredTier` (`standard` or `pro`). Every registered
account sees the published list at `GET /api/v1/links`: links above its plan are
returned locked and without a URL, plus the cheapest plan that unlocks more, so
the app can say "Standard unlocks 3 more" instead of hiding the catalogue. Each
unlocked link carries a freshly minted `sp_ticket`, which is why a ticket left
in browser history expires with its token.

### One proxy session per account

Connecting claims the account's single session (`POST /api/v1/network/session`).
The newest install wins: every other install's node credentials are revoked in
the same request that mints the new ones, so a node stops accepting the previous
device on its next sync, and the previous client's session poll sees
`current: false` and closes its own tunnel. Reconnecting from the same install
keeps its session, so an ordinary reconnect does not churn credentials.

## API surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/v1/auth/register` / `login` / `refresh` / `logout` | none / JWT | Accounts + device-seat-limited tokens |
| `POST /api/v1/auth/password/forgot` / `reset` / `change` | none / JWT | Account recovery; tokens are single-use and expire |
| `DELETE /api/v1/me` | JWT + password | Self-service account deletion |
| `GET /api/v1/me` | JWT | Profile + device seats |
| `GET /api/v1/network/config` | JWT + active sub | Signed dynamic VLESS+REALITY bundle per user |
| `POST` / `GET /api/v1/network/session` | JWT | Claim or check the account's single proxy session |
| `GET /api/v1/network/nodes/public-ips` | public (signed) | Ed25519-signed fleet IP list for Gatekeeper |
| `GET /api/v1/entitlement` | JWT | Short-lived Ed25519-signed plan token for Gatekeeper sites |
| `GET /api/v1/links` | JWT | Operator-published gated links, locked above the account's plan |
| `GET /api/v1/billing/catalog` / `subscription` / `usage` | JWT | Price catalog, plan state (including `autoRenew`), bandwidth usage |
| `POST /api/v1/billing/checkout` | JWT | Open a hosted OpenPay checkout (saves the card) |
| `POST /api/v1/billing/recurring/activate` | JWT | Attach the saved card to the monthly subscription |
| `GET /api/v1/billing/receipt/:reference` | JWT (own checkouts only) | Rendered provider invoice for a settled checkout |
| `POST /api/v1/admin/node-enrollments` | admin JWT | Create a one-time enrollment token scoped to a region |
| `GET /api/v1/admin/node-enrollments` / `DELETE .../:id` | admin JWT | Audit/revoke enrollment tokens |
| `POST /api/v1/nodes/enroll` | one-time token | Self-register a VPS and receive its HMAC identity |
| `GET /api/v1/admin/nodes` / `PATCH .../:id` / `DELETE .../:id` | admin JWT | Global fleet management and lifecycle controls |
| `POST /webhooks/payments` | webhook HMAC | `charge.success` grants/extends the tier; `subscription.canceled` / `subscription.payment_failed` revoke instantly |
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
  JSON and carry a key id; the Gatekeeper refuses unknown/expired/tampered lists.
- **Abuse controls**: the unauthenticated surfaces (`/api/v1/auth/register`,
  `/api/v1/auth/login`, `/api/v1/auth/refresh`, `/api/v1/nodes/enroll`,
  `/webhooks/payments`) are rate limited per client IP, each in its own bucket so
  one endpoint's traffic cannot exhaust another's budget. Controlled by
  `RATE_LIMIT_MAX_ATTEMPTS` and `RATE_LIMIT_WINDOW_SECONDS`.

### Signing keys

The active Ed25519 key lives **only** in the environment (`SIGNING_PRIVATE_KEY_PEM`
plus `SIGNING_KEY_ID`), generated by `generate-env.ts`. There is deliberately no
signing-keys table: a database-stored private half that the signing path never
reads can silently diverge from the key consumers were configured with. To rotate,
replace both variables and restart the controller, then ship the new public key to
the Gatekeeper alongside the old one — `publicKeys` accepts a map, so old and new
key ids can be trusted during the rollout. `npm run db:seed` prints the public key
derived from the currently configured private key; it never mints a second one.

### Tiers and quotas

| Tier | Device seats | Max nodes | 30-day bandwidth quota |
|---|---|---|---|
| `free` | — | — | no tunnel access (registration is not a trial) |
| `standard` | 3 | 10 | unlimited |
| `pro` | 5 | unlimited | unlimited |

Device seats are enforced by evicting the least-recently-seen device, so signing in
on a new phone reclaims the seat instead of locking the user out.

Bandwidth is accounted from the per-credential windows nodes report into
`usage_rollups` and evaluated over a rolling 30-day window, matching the period the
tier catalogue defines. A user who exhausts their quota gets
`402 BANDWIDTH_QUOTA_EXCEEDED` from `GET /api/v1/network/config` and is issued no new
credentials. When a user fetches a bundle, candidate nodes are ranked **healthy
before degraded, then lowest reported load**, so a free-tier user capped at two
nodes is not pinned to whichever two happened to sort first.

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
| `POST /api/v1/admin/nodes` | Register a node directly, bypassing enrollment |
| `POST /api/v1/admin/node-enrollments` | Issue a one-time, region-scoped VPS enrollment token |
| `GET /api/v1/admin/node-enrollments` / `DELETE .../:id` | Audit or revoke enrollment tokens |
| `PATCH /api/v1/admin/nodes/:nodeId` / `DELETE .../:nodeId` | Edit, drain, disable, or remove a node |
| `GET /api/v1/admin/payments/events` | Audit verified payment events and outcomes |
| `GET /api/v1/admin/billing/summary` | Revenue and checkout pipeline rollup |
| `POST /api/v1/admin/billing/refund` | Refund a settled checkout; a full refund revokes access |
| `GET /api/v1/admin/billing/plans` + `POST …/plans/sync` | Provider plans per tier, provisioned from the catalog |
| `PUT /api/v1/admin/billing/plans/price` | Change what a tier costs, at the provider and in the catalog |
| `DELETE /api/v1/admin/billing/plans/price/:tier` | Reset a tier to the price configured for the deployment |
| `POST /api/v1/admin/billing/plans/delete` | Remove a provider plan the tier should no longer use |
| `GET /api/v1/admin/billing/subscriptions` + `POST …/cancel` | List and cancel provider subscriptions |
| `GET/POST /api/v1/admin/disputes…` | List, inspect and contest a chargeback |
| `GET/PUT/DELETE /api/v1/admin/settings/email` | SMTP credentials, admin-configured; the password is encrypted at rest and write-only |
| `POST /api/v1/admin/settings/email/test` | Send a test message |
| `POST /api/v1/admin/users/:userId/password-reset/email` | Issue a reset token and email it |
| `POST /api/v1/admin/billing/lapse-notices` | Email users whose subscription has expired |
| `POST /api/v1/admin/users/:userId/password-reset` | Issue a reset token to hand over out of band |
| `GET /api/v1/admin/billing/checkouts` | Individual checkouts with both references and the owning user |

Most of these back the admin dashboard served at `/admin`; all remain usable
directly by operational tooling. The exceptions with **no dashboard control** —
call them with curl or your own tooling — are:

| Route | Why it has no control |
|---|---|
| `GET /api/v1/admin/disputes…`, evidence submission | the dispute views are not written yet; the API is complete and tested, so evidence can still be filed before a deadline |
| `POST /api/v1/admin/billing/refund` | refunds are deliberately manual |
| `POST /api/v1/admin/billing/lapse-notices` | a bulk mailing action |
| `POST /api/v1/admin/users/:userId/password-reset` and `…/email` | the Settings tab links to the flow; the per-user buttons are not wired |
| `POST /api/v1/admin/nodes` | the dashboard uses the enrollment-token flow instead |

## Usage accounting

The node agent enables sing-box's V2Ray API statistics service on loopback and queries
per-user counters using the local gRPC API. It reports reset counter windows to the
controller; usage rollups have a unique `(credential, windowStart, windowEnd)` key so
retries do not double-count. The deployed sing-box binary must include the V2Ray API
feature/tag, and the agent must be able to read `src/v2rayapi/stats.proto`.

## Payments: OpenPay

Payments run through **OpenPay**, the payment orchestrator SDK
(`@fiatden/openpay`). The controller never calls the provider to decide
entitlement — it opens hosted checkout sessions and then applies only events it
has cryptographically verified.

Set the gateway credentials and the webhook endpoint switches from the
placeholder adapter to the real one automatically:

```dotenv
OPENPAY_API_KEY=pk_live_...
OPENPAY_BASE_URL=https://api.openpay.example.com
OPENPAY_WEBHOOK_SECRET=whsec_...
OPENPAY_SIGNATURE_HEADER=x-webhook-signature-v1
OPENPAY_TIMESTAMP_TOLERANCE_SECONDS=300
```

Configure OpenPay to deliver events to `https://controller.example.com/webhooks/payments`.

### Webhook verification

Signatures are Stripe-style:

```
x-webhook-signature-v1: t=<unix-seconds>,v1=<hex>
signed material:        HMAC-SHA256(secret, "<t>." + rawRequestBody) -> hex
```

Both facts were confirmed against a real delivery — registering an endpoint and
calling `webhooks.test()` — and are replayed as a permanent fixture in
`test/unit/openpay-delivery.test.ts`. OpenPay also sends a legacy
`x-webhook-signature: hex(HMAC-SHA256(secret, rawBody))`, which we ignore.

Verification fails closed on a missing header, a malformed header, a stale or
far-future timestamp (outside `OPENPAY_TIMESTAMP_TOLERANCE_SECONDS`), or any
signature mismatch. The timestamp is inside the signed material, so a captured
webhook cannot be replayed outside the window, and the `payment_events` primary
key makes it idempotent inside it. Getting this wrong would either drop every
payment or let anyone grant themselves a paid tier, so it is covered directly by
`test/integration/openpay-webhooks.test.ts` and `test/unit/openpay.test.ts`.

### Event mapping

| OpenPay event | Applied as | Effect |
|---|---|---|
| `charge.success`, `subscription.activated` | `checkout.completed` | grants/extends the tier |
| `subscription.renewed` | `subscription.renewed` | extends the period (recurring billing) |
| `subscription.paused` / `subscription.resumed` | `subscription.paused` / `subscription.resumed` | stop access keeping the tier / restore with a fresh period |
| `subscription.canceled` | `subscription.deleted` | immediate revocation |
| `subscription.payment_failed` | `invoice.payment_failed` | dunning → revocation |
| `dispute.created` | `charge.disputed` | immediate revocation, including credentials and refresh tokens |
| `dispute.resolved` | `charge.dispute_resolved` | acts only on a stated verdict (`won` restores the tier, `lost` stays revoked); anything else is a no-op |
| `charge.failed` **with** a subscription context | `invoice.payment_failed` | dunning → revocation |
| `charge.failed` **without** a subscription context | *ignored* | acknowledged, no change |
| `charge.refunded` | *ignored* | may be partial; refunds are an operator decision |
| anything else | *ignored* | acknowledged so the provider stops retrying |

A standalone failed charge is deliberately inert: failing a *new* purchase must
not strip an already-paid subscription. The same event inside a recurring
subscription does revoke.

A dispute verdict is read from `Dispute.status`, not from a `resolution` string:
`resolution` is free text, and `resolved` means "closed without a verdict", which
is **not** a win. Verified against the provider's own `Dispute` shape.

### Resolving an event to a user

1. `user_id` echoed in provider metadata (stamped on every checkout we open)
2. A row in `billing_checkouts`, matched on our reference **or** the
   provider-assigned one
3. The subscription's stored provider customer/subscription id
4. An email matching the customer reference

Every branch matches against data we wrote, so an event can never name an
arbitrary user. The `user_id` branch is an optimisation, not a trust boundary.

### Billing catalog

| Tier | Default price (minor units) | Environment setting |
|---|---|---|
| `free` | not purchasable | — |
| `standard` | 200 | `STANDARD_TIER_AMOUNT_MINOR` |
| `pro` | 1000 | `PRO_TIER_AMOUNT_MINOR` |

Currency comes from `BILLING_CURRENCY` (default `USD`); amounts are minor units
(cents), so the defaults are **$2.00/month** and **$10.00/month**. The controller entrypoint refuses to boot on a non-positive or
non-numeric amount, and on a half-configured gateway — a key without its
webhook secret would mean every payment is silently dropped.

The environment holds the **default**. An operator can change what a tier costs
from **Admin → Plans → Change** without a redeploy; that reprices the provider
plan and the catalog together, so the advertised price and the billed price
cannot be left disagreeing. An override carries the amount only — the currency
and which tiers are purchasable stay deployment configuration.

The first payment is a hosted checkout; once its webhook has granted the plan,
the app calls `POST /api/v1/billing/recurring/activate`, which turns the card
saved by checkout into a monthly provider subscription. The provider plan carries
a 30-day trial equal to the already-paid month, so the first renewal — not the
activation itself — is the next charge. `subscription.renewed` extends access
from there; a failed renewal follows the existing dunning path. `PUT` and
`DELETE` on `/api/v1/admin/billing/plans/price` are the API behind that control.

| Route | Purpose |
|---|---|
| `GET /api/v1/billing/catalog` | Purchasable tiers and prices |
| `GET /api/v1/billing/subscription` | Current tier, limits, rolling-window usage |
| `POST /api/v1/billing/checkout` | Open a hosted checkout (rate limited) |
| `GET /api/v1/billing/receipt/:reference` | Rendered invoice for a settled checkout, scoped to the caller |
| `GET /api/v1/billing/usage` | Per-node bandwidth consumption |
| `GET /api/v1/admin/billing/summary` | Revenue + checkout pipeline (admin) |
| `GET /api/v1/admin/billing/checkouts` | Per-checkout ledger for support (admin) |

If `OPENPAY_API_KEY` and `OPENPAY_WEBHOOK_SECRET` are both unset the controller
falls back to the placeholder HMAC adapter so local development still works;
`GET /api/v1/billing/catalog` then reports `gateway: "unconfigured"` and the
client hides the upgrade path.

> `@fiatden/openpay` is pre-1.0. This integration is on **0.0.11**; pin it and
> re-run the payments suite on upgrade.

### Verifying against a live gateway

`test/integration/openpay-live.test.ts` runs the real checkout path against a
real deployment and is skipped in CI (no credentials). Run it with:

```bash
OPENPAY_API_KEY=pk_... \
OPENPAY_BASE_URL=https://api.openpay.example.com \
npm run test:integration
```

It asserts the base URL is reachable, the key is accepted, the catalog loads,
`free` is never purchasable, unsigned webhooks are refused, and — when the
merchant has a settlement provider configured — that a checkout really opens,
returns an https URL, and leaves exactly one `billing_checkouts` ledger row
carrying the provider reference. When no provider is configured the gateway
rejects the charge, and the test asserts the controller reports *that* reason
and records nothing.

Webhook **signature verification is not covered by this suite**: it needs the
provider to deliver a POST to a publicly reachable URL. That path is covered
deterministically by `openpay-webhooks.test.ts`, but it has not been observed
against a real delivery. Confirm the header name against a live delivery before
going live — `OPENPAY_SIGNATURE_HEADER` exists precisely so that can be
adjusted without a code change.

### Gateway errors

A failure at the provider is translated rather than flattened:

| Upstream | Response |
|---|---|
| 4xx | same status, `BILLING_REJECTED` (or `BILLING_RATE_LIMITED` for 429), `providerCode` passed through |
| 5xx | `502 BILLING_PROVIDER_ERROR` |
| not an OpenPay error (DNS, TLS, timeout) | `502 BILLING_PROVIDER_UNAVAILABLE` |

The body carries `error` (the most specific reason the provider gave), `code`
(stable, defined here), `providerCode` (the provider's own code) and `retryable`.
This matters because OpenPay reports actionable causes such as *"No configured
providers available for this merchant"* — a generic `500 internal error` would
have hidden the only thing worth fixing.

## Admin dashboard

The controller serves a dependency-free admin dashboard at **`/admin`**. It is a
plain static bundle — no bundler, no framework, no build step — talking to the
existing admin REST API.

| View | What it does |
|---|---|
| Overview | Fleet/user/credential counts, gross revenue, checkout pipeline |
| Users | Filter, promote/demote, disable/enable, edit tier + status + period |
| Nodes | Fleet health, load, heartbeat, drain/resume, delete, enroll a node |
| Enrollments | Issued tokens with live/used/expired state, revoke |
| Payments | Checkout ledger (what was offered and whether it settled), verified webhook events, revenue |
| Usage | Quota model, ledger state, fleet load |

Design constraints:

- **The UI is not the security boundary.** The bundle contains no secrets and
  every read/write goes through admin routes requiring a JWT *and* the `admin`
  role. Anonymous admin API calls still return `401` with the dashboard
  deployed.
- **Tokens live in `sessionStorage`**, not a cookie, so an XSS cannot
  exfiltrate them via an ambient subrequest. One refresh attempt on `401`, then
  re-authentication.
- **Destructive actions confirm**, and node deletion is distinguished from the
  reversible "drain".
- The bundle is served `no-store` and `nosniff`; `/admin` is `noindex`.
- Removing the bundle never takes the API down — the mount is skipped with a
  warning if `index.html` is missing.

Client-side logic is tested against a DOM shim (`test/unit/admin-ui.test.ts`),
which executes every view and fires every button handler without a browser.

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

`.github/workflows/client.yml` runs tests and analysis for client changes. On
pushes to `main` and `release/*`, it also builds the native `libbox.aar` from the
commit pinned in `apps/client/libbox.ref` and uploads versioned Linux and Android
artifacts. The Android artifact is always a signed release build, and the job
fails with an explicit list when the four release secrets or the
`CLIENT_CONTROLLER_URL` / `CLIENT_SIGNING_PUBLIC_KEY` variables are missing —
see [`docs/RELEASE-CLIENT.md`](docs/RELEASE-CLIENT.md) for the one-time setup and
`gh workflow run client` to build on demand. The manual `client-release` workflow
runs the same chain for a specific version or a GitHub release. It always builds the iOS client on a macOS runner with
`--no-codesign`, which proves the iOS build compiles even though signing needs a
release identity. The workflow intentionally does not publish client binaries for
pull requests or development branches.

The Android host project is generated because it is intentionally not committed:

```bash
cd apps/client
flutter create --platforms=android,linux .
./tool/configure-android-host.sh   # real package id and launcher label
```

The Android bridge requests VPN permission, starts the foreground service, and
reports native failures back to the UI; it never claims a connection when the
libbox artifact or VPN permission is unavailable.


## Docker server deployment

Not sure which of the five Compose files and four environment files you need?
[`docs/FILE-MAP.md`](docs/FILE-MAP.md) answers that in one page, and names the
files you never have to touch.

> **Using Dokploy?** Use [`docs/DOKPLOY.md`](docs/DOKPLOY.md) instead of the
> Compose/Caddy steps below. It covers a Traefik-native controller stack
> (`docker-compose.dokploy.yml`), one node stack per exit VPS
> (`docker-compose.dokploy-node.yml`), and the signed client release.

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
validates the JWT/webhook/signing secrets, applies the committed Drizzle
migrations (`apps/controller/drizzle/*.sql`, idempotent on every boot), and exposes
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
set `CORS_ORIGINS` to the actual client origins — with `NODE_ENV=production` the
controller refuses to boot on `*`, and on a `localhost` `PUBLIC_APP_URL`.

### Docker node agent

The node profile requires a Linux host with `/dev/net/tun` and `NET_ADMIN`:

```bash
docker compose --profile node --env-file .env.docker \\
  -f docker-compose.production.yml up -d --build
```

On first boot provide `NODE_ENROLLMENT_TOKEN` and `NODE_HOSTNAME`. `NODE_PUBLIC_IP`
is optional — leave it empty and the agent detects the VPS's public address (via
`NODE_PUBLIC_IP_ECHO_URL`, default `https://api.ipify.org`) and reports it on
enrollment and every heartbeat, so a re-addressed node heals itself. The node
image contains Node 22, the agent dependencies, and the pinned sing-box release.
It runs sing-box in managed mode because Docker does not provide systemd; node
identity persists in `NODE_IDENTITY_VOLUME`. The entrypoint fails closed when
enrollment or the public endpoint is missing. Run one node-agent container per
VPS with a unique enrollment token; do not expose its stats listener.

### CI, artifacts, and live smoke test

`.github/workflows/server-ci.yml` validates the server on pull requests. Pushes to
`main` and `release/*` build and publish the controller image to GHCR and upload
a versioned node-agent deployment archive. The node-agent image is published by
`node-agent.yml` below, whose build pins sing-box with `SING_BOX_VERSION`.

`.github/workflows/node-agent.yml` is the node image's release path: it publishes
`ghcr.io/<owner>/strict-proxy-node-agent` for amd64 and arm64, then pulls the
digest it pushed and checks sing-box in both architectures, the entrypoint's
enrollment guard, and — when the `NODE_CONTROLLER_URL` variable is set — that the
container can reach the controller. The Dokploy node stack runs that image
instead of building on the VPS; see
[`docs/DOKPLOY.md` §5](docs/DOKPLOY.md#5-add-exit-nodes).

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

### Tests

```bash
npm run test:unit          # no infrastructure required
npm run test:integration   # boots ephemeral Postgres + Redis
npm test                   # both
```

Unit tests cover the shared primitives that everything else rests on: HMAC signing
strings, Ed25519 canonical-JSON signing/verification, REALITY key generation, strict
env parsing, the tier catalogue, load scoring, enrollment tokens, client-IP
extraction in the Gatekeeper, and the node agent's sing-box config renderer.

Integration tests use the built-in `node:test` runner with
[testcontainers](https://node.testcontainers.org/), so they exercise the real
Express app, the real Drizzle schema and real Postgres/Redis. They cover the auth
and refresh-rotation flows, the admin authorization matrix over every admin route,
node enrollment and the HMAC internal API (forged signature, stale timestamp, nonce
replay, cross-node usage isolation), webhook signature verification and idempotency,
signed config bundles and IP lists, rate-limit enforcement per bucket and per IP,
bandwidth quota enforcement, load-aware node assignment, and the Gatekeeper
admit/deny and failure modes end to end.

`test/helpers/` holds the harness: `infra.ts` starts the containers and applies the
Drizzle schema with `drizzle-kit push`, and `harness.ts` boots the controller
in-process and exposes a small HTTP client plus fleet/seed helpers. Docker must be
reachable for `test:integration`.

Because each test file runs in its own process, every file starts its own container
pair. Run integration files with the default concurrency of 1 to bound memory on
smaller machines; override the images with `TEST_POSTGRES_IMAGE` and
`TEST_REDIS_IMAGE`.

`.github/workflows/server-ci.yml` runs both suites on every pull request.

### Checkout ledger

Every checkout the controller opens is recorded in `billing_checkouts` with both
our reference and the provider-assigned one. That row is what lets a webhook be
resolved back to a user even when the provider drops the metadata we attached,
and what an admin reads when a customer says they paid but still have no
access: `GET /api/v1/admin/billing/checkouts` shows both references, the owning
user, and whether it settled.

Abandoned checkouts are reclaimed by a periodic sweep alongside the node-status
sweep, so an abandoned session cannot sit `open` forever.

## Account & billing in the client

The client exposes an **Account** screen (person icon on the home screen) that
shows the live server-side state rather than assuming a purchase succeeded:

- current tier, subscription status and renewal date
- device-seat and node limits
- a bandwidth usage bar for capped tiers, with an explicit "quota reached"
  warning and a pointer to upgrade
- the purchasable plans, cheapest first, with an Upgrade/Switch action
- per-node usage breakdown

The home screen also carries a plan strip showing the tier, remaining data, and
any non-active status, so a limited connection can be explained without opening
the account screen. It renders nothing until subscription data arrives, so
nothing wrong is ever flashed on first paint.

Upgrades open a hosted **OpenPay** checkout. Because entitlement is granted by a
verified webhook, not by the redirect returning, the screen shows a snackbar
telling the user to reload rather than optimistically upgrading the local tier.

When the deployment has no gateway configured, `GET /api/v1/billing/catalog`
reports `gateway: "unconfigured"` and the upgrade section is replaced with an
explanatory notice instead of buttons that cannot work.
