# Architecture at a glance

Orientation for humans and coding agents. One page first, detail after.

## TL;DR

A four-module platform: a **controller** that owns identity, entitlements and
the node registry; a **fleet of node agents** that run sing-box and report
usage; a **Flutter client** that consumes signed config bundles; and a
**Gatekeeper SDK** that admits only traffic arriving through a fleet exit node.

Everything that grants access is derived from two trusted inputs:

| Input | Trust | Why |
|---|---|---|
| A **signed config bundle** from the controller | Ed25519 signature + JWT | per-node credentials are minted server-side |
| A **signed IP list** from the controller | Ed25519 signature | Gatekeeper admits only known exit nodes |

Payments go through **OpenPay**. The controller never grants entitlement because
a client asked — only because a webhook it cryptographically verified said so.

## Repository map

```
packages/types/          Shared primitives: domain types, HMAC + Ed25519 helpers,
                         REALITY keygen, strict env parsing. No I/O.
packages/gatekeeper/     Express middleware. Fetches + verifies the signed fleet
                         IP list, admits or denies. Used by third-party origins.

apps/controller/         The brain.
  src/routes.ts            Public + admin API (auth, network, admin, node HMAC).
  src/routes/billing.ts    Billing API for users and the billing summary for admins.
  src/middleware.ts        JWT, admin role, node HMAC, error handler.
  src/services/
    openpay.ts             OpenPay adapter: signature verification + event mapping.
    payments.ts            Webhook pipeline: verify -> map -> apply (idempotent).
    billing.ts             Opens hosted checkouts, writes the checkout ledger.
    checkout-resolution.ts Webhook -> user resolution. No SDK import, by design.
    catalog.ts             Tier -> price mapping, validated at boot.
    usage.ts               Rolling-window bandwidth accounting for quotas.
    rate-limit.ts          Redis fixed-window limiter for unauthenticated routes.
    config.ts              Signed config bundle; ranks nodes by health and load.
    nodes.ts               Enrollment, credentials, node + subscription sweeps.
    auth.ts                JWT issue/verify, refresh rotation, device seats.
    tiers.ts               Tier catalogue (seats, node caps, quota).
  src/admin/               Build-free admin SPA served at /admin.
  test/                    (integration tests live in the repo-root test/ dir)

apps/node-agent/        Runs on each VPS. Enrollment, heartbeat, credential sync,
                         sing-box config convergence, usage reporting.

apps/client/            Flutter app: login, server picker, connect, account.
```

## Request paths worth knowing

**Client gets credentials**
```
Flutter ──GET /api/v1/network/config (JWT)──> controller
                                               │ quota check (usage rollups)
                                               │ rank nodes: healthy, then least loaded
                                               │ mint VLESS UUID per (user, node)
                                               └─ signed bundle {nodes, configs, signature}
Flutter ──connect VLESS+REALITY──────────────> fleet node ──> internet
```

**Gatekeeper protects an origin**
```
request ──> Gatekeeper middleware
              │ fetch + verify signed IP list (cached, Ed25519)
              │ IP is a live fleet node? ──yes──> origin serves
              └─────────────────────────────────no───> 403 GATEKEEPER_DENIED
```

**Money moves**
```
Flutter ──POST /api/v1/billing/checkout (JWT)──> controller
                                                    │ checkout.create + idempotency_key
                                                    │ write billing_checkouts row
                                                    └─ checkout_url
   ...customer pays on the provider's hosted page...
provider ──POST /webhooks/payments (signed)──> controller
              │ verify Stripe-style signature over the raw body
              │ map event -> checkout.completed / subscription.deleted / ...
              │ resolve user: metadata -> ledger -> provider refs -> email
              │ apply: grant tier, or revoke credentials + refresh tokens
              └─ ack (idempotent via payment_events PK)
```

**Node reports in**
```
node ──POST /internal/v1/node/heartbeat (HMAC: method+path+ts+nonce+body)──> controller
node ──GET  /internal/v1/node/sync       (HMAC)──> desired credentials
node ──POST /internal/v1/node/usage      (HMAC)──> bandwidth windows
```

## Where the trust boundaries are

| Boundary | Mechanism | Failure mode |
|---|---|---|
| Client -> controller | JWT, short-lived, device-bound | `401` |
| Admin routes | JWT **and** `role === 'admin'` | `401` / `403` |
| Node -> controller | HMAC-SHA256 + single-use nonce + timestamp window | `401` |
| Provider -> controller | Stripe-style HMAC over the raw body + timestamp | `401` |
| Public artifacts | Ed25519 over canonical JSON, key-id tagged | consumer refuses |
| Unauthenticated routes | per-IP Redis limiter, one bucket per endpoint | `429` |
| Device seats | evict least-recently-seen device | reclaims the seat |

## Data model (11 tables)

| Table | Holds | Notes |
|---|---|---|
| `users` | identity, role, disabled flag | soft disable, never deleted |
| `devices` | one row per install | backs seat accounting |
| `refresh_tokens` | SHA-256 of opaque token | single-use; rotated on every refresh |
| `subscriptions` | tier, status, period end | status is reconciled by a sweep |
| `payment_events` | every verified webhook | PK = provider event id => idempotency |
| `billing_checkouts` | checkouts we opened | links provider reference -> user |
| `nodes` | fleet registry, load, status, HMAC secret | `offline` until first heartbeat |
| `node_enrollments` | hashed one-time tokens | consumed atomically, never replayed |
| `node_credentials` | VLESS UUID + short-id per user/node | revoked = cut off |
| `usage_rollups` | bandwidth windows | unique `(credential, windowStart, windowEnd)` |
| `revoked_access_tokens` | JTI after logout | checked on every authenticated request |

## Background maintenance

One 30s sweep, three independent jobs. A failure in one must not stop the others.

| Job | Effect |
|---|---|
| `refreshNodeStatus` | nodes with a stale heartbeat -> `offline` |
| `expireStaleCheckouts` | abandoned checkouts -> `expired` |
| `expireLapsedSubscriptions` | elapsed billing periods -> `expired` (keeps the tier) |

## OpenPay integration: what we use and what we ignore

The SDK exposes **32 resources**. This platform uses **three methods**, plus two
reads in the live suite. Knowing which is deliberate prevents a well-meaning
agent from "helpfully" wiring up something that does not belong here.

### Used

| Call | Where | Why |
|---|---|---|
| `checkout.create` | `services/billing.ts` | hosted payment page, the only way a customer pays |
| `status.get` | live suite | reachability + provider health |
| `currencies.list` | live suite | proves the key is accepted |

### Mapped from webhooks

| OpenPay event | Our effect |
|---|---|
| `charge.success`, `checkout.completed` | grant / extend the tier |
| `subscription.deleted` / `canceled` / `cancelled` | revoke immediately |
| `subscription.renewal_failed`, `invoice.payment_failed` | dunning -> revoke |
| `charge.failed` **inside a subscription** | dunning -> revoke |
| `charge.failed` **standalone** | ignored — a failed new purchase must not cancel an existing plan |
| anything else | acknowledged, ignored |

### Deliberately NOT used, and why

Most of the SDK is aimed at a general-purpose payments platform. Nearly all of
it is wrong for a VPN that meters its own bandwidth.

| Not used | Reason |
|---|---|
| `subscriptions.*`, `createPlan` | we mint a tier and a period end ourselves; see *Known gap* below |
| `billing.*`, `metering.*` | our usage is bandwidth per node, which only we can measure |
| `wallets.*`, `financialAccounts.*` | WaaS is for embedding a balance in a third-party product |
| `payouts.*` | no node-operator payouts |
| `disputes.*`, `riskReview.*` | no chargeback handling yet — a real gap, see below |
| `apps.*` workspaces | single workspace; `app_id` scoping unused |
| `coupons.*` | no marketing discounts |
| `fx.*`, `currencyPortfolio.*`, `currencies.upsert` | single currency per checkout |
| `reconciliation.*` | no ledger reconciliation |
| `customers.*` CRM/GDPR | our own `users` table is authoritative |
| `apiKeys.*`, `webhooks.*`, `platform.*`, `emailTemplates.*`, `totp.*`, `auth.*` | merchant-console concerns; these need a **session token**, not our API key, and are operated in the OpenPay dashboard |
| `paymentLinks.*`, `referrals.*`, `analytics.*` (deep) | no current consumer |

> Practical consequence: `webhooks.list()` and `auth.me()` return `401` with an
> API key. That is expected — those are console endpoints. Webhook endpoints and
> merchant credentials are configured in the OpenPay dashboard, not by this
> codebase.

## Known gaps

Honest list, so nobody assumes these are handled.

| Gap | Impact | Where it would go |
|---|---|---|
| **No recurring billing** | a customer pays once, gets 30 days, then access lapses with no renewal. The webhook side already understands renewal events. | OpenPay `plans` + `subscriptions.create`; map `subscription.renewed` -> extend |
| **Webhook signature unverified against a live delivery** | the scheme is implemented to spec and unit-tested, but has never seen a real signed request | confirm the header name on a real delivery; `OPENPAY_SIGNATURE_HEADER` is configurable |
| **No dispute / chargeback handling** | a chargeback would leave the customer with paid access indefinitely | subscribe to `charge.disputed` / `charge.reversed` and revoke |
| **No migrations committed** | schema is applied with `drizzle-kit push` at boot; there is no versioned migration history | generate and commit `drizzle/` SQL before running more than one environment |
| **No email** | no receipts, no "your plan lapsed" notice | OpenPay `emailTemplates`, or a worker |
| **Android/iOS builds unverified locally** | libbox `.aar` is a build-time prerequisite; the bridge is implemented and CI-analyzed but not exercised on a device | `apps/client/tool/build-libbox.sh` |

## Testing map

Run `npm test` (unit + integration). Integration boots real Postgres and Redis
via testcontainers, so it needs Docker.

| Suite | Covers |
|---|---|
| `test/unit/crypto.test.ts` | HMAC signing strings, Ed25519 canonical JSON, key-cache correctness |
| `test/unit/openpay.test.ts` | signature parsing/verification, event mapping, gateway error translation |
| `test/unit/policy.test.ts` | tier catalogue, load scoring, node ranking |
| `test/unit/admin-ui.test.ts` | every dashboard view rendered and every button fired, via a DOM shim |
| `test/integration/auth.test.ts` | register/login/refresh rotation/logout/seats |
| `test/integration/admin.test.ts` | the admin authorization matrix over every admin route |
| `test/integration/fleet.test.ts` | enrollment, HMAC internal API, nonce replay, usage isolation |
| `test/integration/network.test.ts` | signed bundles, load-aware assignment, quota enforcement |
| `test/integration/subscription-lifecycle.test.ts` | pay -> lapse -> renew, and status honesty |
| `test/integration/openpay-webhooks.test.ts` | signature rejection, idempotency, user resolution |
| `test/integration/openpay-live.test.ts` | the real gateway; skipped unless `OPENPAY_API_KEY` is set |
| `test/integration/gatekeeper.e2e.test.ts` | admit/deny, forged keys, failure modes |

## Invariants worth not breaking

1. **Entitlement is only ever granted by a verified webhook.** No endpoint may
   set a tier because a client asked.
2. **Public artifacts are always signed**, and verification fails closed on
   unknown key ids, expiry, or tampering.
3. **Credentials are revoked on the way down**, not just blocked: a cancelled
   customer must lose their VLESS UUID, not merely be denied a new bundle.
4. **The signing key lives in the environment only.** No database copy.
5. **Rate-limit buckets are per endpoint.** Sharing one lets traffic on a cheap
   endpoint exhaust a login budget.
6. **Report what is true.** The admin dashboard must not count a lapsed
   customer as paying — this is why `expireLapsedSubscriptions` exists.