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
  src/routes/billing-ops.ts Provider plans + subscription cancellation, admin only.
  src/routes/account.ts     Password reset/change, account self-deletion, refunds.
  src/routes/mail.ts        SMTP settings and the test send.
  src/middleware.ts        JWT, admin role, node HMAC, error handler.
  src/services/
    openpay.ts             OpenPay adapter: signature verification + event mapping.
    payments.ts            Webhook pipeline: verify -> map -> apply (idempotent).
    billing.ts             Opens hosted checkouts, writes the checkout ledger.
    plans.ts               Provider plan per tier, provisioned from the catalog.
    pricing.ts             Operator price overrides (amount only; currency stays config).
    checkout-resolution.ts Webhook -> user resolution. No SDK import, by design.
    catalog.ts             Tier -> price mapping, validated at boot.
    settings.ts            Platform settings; secrets encrypted at rest (AES-256-GCM).
    mail.ts                SMTP transport, templates, delivery outcomes.
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
| Admin routes | JWT **and** a role permission (`requirePermission`) | `401` / `403` |
| Node -> controller | HMAC-SHA256 + single-use nonce + timestamp window | `401` |
| Provider -> controller | Stripe-style HMAC over the raw body + timestamp | `401` |
| Public artifacts | Ed25519 over canonical JSON, key-id tagged | consumer refuses |
| Unauthenticated routes | per-IP Redis limiter, one bucket per endpoint | `429` |
| Device seats | evict least-recently-seen device | reclaims the seat |

### Roles and permissions

Admin authorisation is permission-based rather than a `role === 'admin'` string
repeated in handlers. `services/rbac.ts` is the single mapping:

| Permission | Administrator | User |
|---|---|---|
| `users.read` | yes | no |
| `users.create` | yes | no |
| `users.update` | yes | no |
| `users.subscription` | yes | no |

`requirePermission(cfg, db, 'users.create')` composes the normal JWT check and
fails closed: an unknown role or permission is refused, never treated as an
administrator. The user-management routes use it; routes outside that family
still use `requireAdmin`, which is the same rule while administrators hold every
permission. A new role is one entry in `ROLE_PERMISSIONS`.

`POST /api/v1/admin/users` creates an account from the dashboard: email and
password are validated, the password is bcrypt-hashed and never returned, a
free subscription row is created in the same transaction, and `user.created` is
written to the audit log with the acting administrator and role.

## Data model (13 tables)

| Table | Holds | Notes |
|---|---|---|
| `users` | identity, role, disabled flag | soft disable, never deleted |
| `devices` | one row per install | backs seat accounting |
| `refresh_tokens` | SHA-256 of opaque token | single-use; rotated on every refresh |
| `subscriptions` | tier, status, period end | status is reconciled by a sweep |
| `payment_events` | every verified webhook | PK = provider event id => idempotency |
| `billing_checkouts` | checkouts we opened | links provider reference -> user |
| `nodes` | fleet registry, load, status, HMAC secret, IP provenance | `offline` until first heartbeat; `public_ip_source` records whether the address was supplied, auto-detected or set by an admin |
| `node_enrollments` | hashed one-time tokens | consumed atomically, never replayed; active tokens can be rotated atomically, which revokes the old row and creates a replacement with the same region, label and lifetime |
| `node_credentials` | VLESS UUID + short-id per user/node | revoked = cut off |
| `usage_rollups` | bandwidth windows | unique `(credential, windowStart, windowEnd)` |
| `revoked_access_tokens` | JTI after logout | checked on every authenticated request |
| `password_reset_tokens` | SHA-256 of a reset token | single-use, 30-minute expiry (`0001`) |
| `platform_settings` | operator settings, encrypted when secret | also holds plan-id and price-override cache (`0002`) |

## Credential lifecycle

| Credential | Lifetime | Rotation |
|---|---|---|
| Client access JWT | 15 minutes | reissued by `/api/v1/auth/refresh` |
| Client/admin refresh token | 30 days | single-use; every refresh rotates the pair |
| Password-reset token | 30 minutes | single-use; a new request supersedes the old link |
| Node enrollment token | 5 minutes – 24 hours | **Admin → Enrollments → Rotate** revokes the old token and issues a replacement with the same region and label; consumed tokens cannot be rotated |
| Node HMAC secret | until the node is deleted or re-enrolled | issued once at enrollment and persisted in the node identity volume; there is no in-place rotation endpoint, so treat a suspected leak as a node re-enrollment |
| Signing key | until deliberately rotated | environment-level; rotation invalidates every installed client |

## Background maintenance

One 30s sweep, three independent jobs. A failure in one must not stop the others.

| Job | Effect |
|---|---|
| `refreshNodeStatus` | nodes with a stale heartbeat -> `offline` |
| `expireStaleCheckouts` | abandoned checkouts -> `expired` |
| `expireLapsedSubscriptions` | elapsed billing periods -> `expired` (keeps the tier) |

A fourth job would be `reconcileWithGateway`, which is not written: the billing
data is ours, and nothing else needs syncing.

## OpenPay integration: what we use and what we ignore

The SDK exposes **32 resources**. This platform uses **three methods**, plus two
reads in the live suite. Knowing which is deliberate prevents a well-meaning
agent from "helpfully" wiring up something that does not belong here.

### Used

| Call | Where | Why |
|---|---|---|
| `checkout.create` | `services/billing.ts` | hosted payment page for the first month; saves the card for recurring billing |
| `subscriptions.create` | `services/recurring.ts` | starts the monthly subscription from the saved card after the first payment clears |
| `customers.paymentMethods` | `services/recurring.ts` | finds the reusable card saved by checkout |
| `checkout.create` (discounted amount) | `routes/billing.ts` | applies a local coupon before the session opens; the provider only sees the final amount |
| `disputes.list` / `get` / `listEvidenceSubmissions` | `routes/disputes.ts` | contest a chargeback instead of losing it |
| `disputes.submitEvidence` / `markSubmitted` | `routes/disputes.ts` | file the evidence packet |
| `charges.invoice` | `routes/billing.ts` | renders a receipt for a settled checkout |
| `apps.list` | `services/plans.ts` | derive the merchant id plans are created under |
| `subscriptions.listPlans` / `getPlan` | `services/plans.ts` | find the tier's plan and check it is still sellable |
| `subscriptions.createPlan` | `services/plans.ts` | create the tier's plan from the catalog |
| `subscriptions.updatePlan` | `services/plans.ts` | an operator price change, at the provider |
| `subscriptions.deletePlan` | `services/plans.ts` | remove a plan a tier should no longer use (archives when history references it) |
| `subscriptions.cancel` | `routes/billing-ops.ts` | stop a subscription we are serving |
| `status.get` / `currencies.list` | live suite | reachability and key acceptance |

### Mapped from webhooks

Every name below is real — taken from the provider's own validation error.

| OpenPay event | Our effect |
|---|---|
| `charge.success`, `subscription.activated` | grant / set the tier |
| `subscription.renewed` | extend the period (recurring billing) |
| `subscription.paused` | stop access, keep the tier and the period |
| `subscription.resumed` | restore access with a fresh period |
| `subscription.canceled` | revoke immediately |
| `subscription.payment_failed` | dunning -> revoke |
| `dispute.created` | revoke immediately (money taken back) |
| `charge.failed` inside a subscription | dunning -> revoke |
| `charge.failed` standalone | ignored — a failed new purchase must not cancel an existing plan |
| `charge.refunded` | ignored — may be partial; refunds are an operator decision |
| `dispute.resolved`, `dispute.evidence_submitted` | ignored — outcome not in the envelope |
| `wallet.*`, `payout.*`, `financial_account.created` | not our concern |

### Deliberately NOT used, and why

Most of the SDK is aimed at a general-purpose payments platform. Nearly all of
it is wrong for a VPN that meters its own bandwidth.

| Not used | Reason |
|---|---|
| `charges.tokenize` | the hosted checkout already saves the card; tokenization adds a second payment surface the mobile client cannot render |
| `billing.*`, `metering.*` | our usage is bandwidth per node, which only we can measure |
| `wallets.*`, `financialAccounts.*` | WaaS is for embedding a balance in a third-party product |
| `payouts.*` | no node-operator payouts |
| `riskReview.*` | the provider's own risk review; disputes are handled from our side |
| `apps.*` beyond `apps.list` | single workspace; the app id scopes provider objects but is not a product concept here |
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

### Verified against the live gateway

The webhook signature scheme and the event vocabulary are no longer assumptions.
Both were recovered from the provider itself: registering a webhook endpoint
against a capture server and calling `webhooks.test()` produced a real signed
delivery, and subscribing to an unknown event name returned the authoritative
list.

| Fact | Value | Source |
|---|---|---|
| Primary signature header | `x-webhook-signature-v1` | captured delivery |
| v1 signed material | `HMAC-SHA256(secret, "<t>." + rawBody)` -> hex | computed and matched |
| Legacy header | `x-webhook-signature` = `hex(HMAC-SHA256(secret, rawBody))` | computed and matched |
| Event envelope | `{ id, type, created_at, data }` | captured delivery |
| Event names | 20, listed in `OPENPAY_EVENTS` | provider validation error |

`test/unit/openpay-delivery.test.ts` replays the captured request as a permanent
fixture, so a change to the verifier, the header name or the signed material
fails a test rather than silently dropping every payment.

### Fixed

| Was | Fix |
|---|---|
| Chargebacks left the customer with access forever | `dispute.created` revokes as hard as a cancellation, including credentials and refresh tokens |
| Refunds auto-revoked | deliberately **not** mapped: refunds may be partial, so it is an operator decision |
| No versioned migrations | `apps/controller/drizzle/*.sql` committed; the container entrypoint runs `db:migrate`, idempotent on every boot |
| Lapsed subscriptions still claimed `active` | `expireLapsedSubscriptions` reconciles the row so the admin dashboard and `/api/v1/me` stop lying |
| Abandoned checkouts never reclaimed | `expireStaleCheckouts` wired into the periodic sweep |
| No receipts | `GET /api/v1/billing/receipt/:reference`, scoped to the caller, renders the provider invoice |
| No way to contest a chargeback | `routes/disputes.ts`: list, inspect, file evidence, mark hand-submitted |
| Coupons were the gateway's, so a code could not be created or revoked locally | a local `coupons` table enforces percent/fixed discounts, one redemption per account and an optional cap/expiry; a bad code is a 400 before a session opens, and the discount is capped so a payable checkout never becomes free. It applies to the first payment — the gateway has no subscription discount field, so renewals bill at plan price |
| Recurring billing absent | `subscription.renewed` extends the period; pause/resume supported; replays idempotent |
| Invented event names in the mapping | replaced with the provider's authoritative 20, exported as `OPENPAY_EVENTS` |
| The development adapter used a different event vocabulary than production | it now accepts both, so a locally replayed webhook behaves as the real one does |
| Changing what a tier costs required a redeploy | `PUT /api/v1/admin/billing/plans/price` reprices the provider plan and the catalog in one action; a reset pushes the configured amount through the same path rather than deleting the override and leaving the two disagreeing |
| "Logout" left the refresh token valid | `POST /api/v1/auth/logout` also revokes the refresh token the client sends, so logout ends the session rather than just the access token |
| The Enrollments tab's "Issue new" button did nothing | it selected `[data-open-enroll]`, which nothing ever rendered; the enrollment dialog is now a shared function both the Nodes and Enrollments views call |
| The Docker controller never received `PUBLIC_APP_URL` or `SETTINGS_ENCRYPTION_KEY` | both were documented but not forwarded by compose, so secrets fell back to a JWT-derived key and reset emails linked to `localhost`; both are forwarded now |
| A node's public IP had to be supplied by hand, and a re-addressed VPS kept a stale allowlist entry | enrollment accepts the address the node connected from when none is given, the agent detects its own address and reports it on every heartbeat, and the controller applies it (`NODE_IP_AUTODETECT`, on by default); private addresses are refused and the dashboard shows whether an address was auto-detected or set by an admin |
| "Is billing broken, and is it us?" could only be answered by curling the provider | `GET /api/v1/admin/billing/providers` surfaces the gateway's readiness, health, and the saved connection test's real error in the Plans view, so a bad key is distinguishable from an unready merchant account before a customer hits it; **Test connection** (`POST …/providers/test`) runs the provider's own check, which is what clears the stale failure history that otherwise makes a valid key unroutable |
| The shipped defaults were development defaults | `NODE_ENV=production` now refuses to boot on the two settings that must be deliberate — `CORS_ORIGINS=*` (which used to be the default) and a `localhost` `PUBLIC_APP_URL` — and warns on the softer ones (HSTS off, no gateway key, placeholder gateway URL, empty `SETTINGS_ENCRYPTION_KEY`, short `JWT_SECRET`). `CORS_ORIGINS` defaults to *empty* rather than `*`, and compose ships `ENABLE_HSTS=true`, so a lazy deploy cannot inherit the open posture |
| A user who forgot their password, or wanted to leave, had no in-app path | the client has a recovery screen (request a link, or paste the code/link an operator relays) reached from **Forgot password?**, and an account-deletion flow guarded by a password confirm; both call the already-tested controller routes |
| `drizzle-orm` was pinned at `0.38`, which carried a high-severity identifier-escaping advisory | bumped to `0.45.4` (with `drizzle-kit` `0.31.11`). The advisory was unreachable here — nothing calls `sql.raw()` — but the "seven-minor jump is breaking" worry was only that: no query in this codebase needed changing, and `migrations.test.ts` still applies the committed SQL |

### Bundle verification

The controller signs every config bundle with Ed25519. The Flutter client now
verifies that signature before any credential reaches the tunnel, via the
`cryptography` package (`lib/features/engine/bundle_verifier.dart`). The Dart
canonical-JSON implementation is pinned against fixtures produced by the
controller's own signer (`test/tools/emit-canonical-fixtures.ts`), because a
byte-level mismatch would fail every genuine bundle.

Two details that are easy to get wrong and are covered by tests:

- The signed payload uses the **raw `expiresAt` string** from the response.
  Re-serialising it through a `DateTime` drops a zero fractional part
  (`…T00:00:00.000Z` → `…T00:00:00Z`), which would fail verification and present
  as a tampered bundle.
- Verification **fails closed**. In a production build with no signing key
  configured, `ConfigBundleLoader` refuses to connect rather than downgrading to
  no verification.

### Mail

SMTP is configured from **Admin → Settings**, not the environment: credentials
are per-deployment and rotate independently of a deploy.

| Route | Purpose |
|---|---|
| `GET/PUT/DELETE /api/v1/admin/settings/email` | Read, save and remove SMTP settings |
| `POST /api/v1/admin/settings/email/test` | Send a test message to an address you choose |
| `POST /api/v1/admin/users/:userId/password-reset/email` | Issue a reset token *and* email it |
| `POST /api/v1/admin/billing/lapse-notices` | Notify users whose subscription has expired |

Two properties worth stating explicitly:

- **The password is write-only.** It is encrypted at rest with AES-256-GCM under
  a key derived from `SETTINGS_ENCRYPTION_KEY` (falling back to the JWT secret),
  and no API call returns it — `describeSettings` reports only that a value
  exists. An admin can replace the password but never read it back. Leaving the
  field blank keeps the stored one; clearing it is a separate, explicit action.
- **Sending never throws into a request.** `sendMail` reports what happened, and
  each caller decides how loudly to complain, because every caller is a recovery
  or lifecycle path — a mail outage must not turn a password reset into a 500,
  and must not make it look like it worked.

With mail configured, `POST /api/v1/auth/password/forgot` delivers the reset link
directly. Without it, the flow still succeeds and the operator relays the token
via `POST /api/v1/admin/users/:userId/password-reset`, which remains available.

Delivery uses `nodemailer`. It ships no bundled types and `@types/nodemailer`
is still at 8.x, so the types describe v8 while the runtime is v10; the surface
used here (`createTransport`, `sendMail`) is unchanged between them.

### Dispute outcomes

`dispute.resolved` was previously unmapped on the assumption that the envelope
carried no verdict. That assumption was wrong, and has been corrected against the
provider's own `Dispute` type:

```ts
interface Dispute {
  status: 'open' | 'under_review' | 'won' | 'lost' | 'resolved';
  resolution?: string;  // free text
  ...
}
```

The verdict **is** the status. `won` and `lost` are terminal; `resolved` means
closed without stating who prevailed, and is deliberately treated as *no
verdict* rather than as a win — restoring paid-for service on an ambiguous
signal is the irreversible error, while leaving a revocation in place is
recoverable by an operator.

| Outcome | Effect |
|---|---|
| `won` | restores the tier read from the **disputed charge**, with a fresh period |
| `lost` | leaves access revoked (already revoked when the dispute opened) |
| `resolved` / absent | changes nothing, either direction |

Two things that were wrong on the first attempt, both now covered by tests:

- The tier must come from the settled charge, not the current subscription row
  (which the dispute itself already flattened to `free`), and
  `findCheckoutForEvent` only matches *unsettled* rows by design — so a
  settled-charge lookup was added.
- `transaction_id` was not among the candidate references, so a dispute could
  not be connected to the purchase at all.

`resolution` is free text and never decides anything; a narrative containing the
word "won" must not restore access.

### Plan provisioning

A provider plan per tier is required before a subscription can be started, and
`checkout.create` takes an amount rather than a plan — so plans used to be
created by hand, letting the catalog prices and the billed prices drift apart
silently.

Plans are now created from the catalog and found again by a tier tag written
into the plan's `metadata`. The `platform_settings` cache is only ever a hint:
it is verified against the provider on every lookup, and a plan deleted out of
band is rebuilt rather than reused.

| Route | Purpose |
|---|---|
| `GET /api/v1/admin/billing/plans` | Catalog vs provider, side by side, including the price the deployment is configured with |
| `POST /api/v1/admin/billing/plans/sync` | Create any missing plan |
| `PUT /api/v1/admin/billing/plans/price` | Set what a tier costs, at the provider and in the catalog |
| `DELETE /api/v1/admin/billing/plans/price/:tier` | Reset a tier to the price configured for the deployment |
| `POST /api/v1/admin/billing/plans/delete` | Remove a plan the tier should no longer use |
| `GET /api/v1/admin/billing/subscriptions` | Provider subscriptions, joined to local users |
| `POST /api/v1/admin/billing/subscriptions/cancel` | Cancel and stop serving |

Deliberate behaviours:

- **A drifted price is reported, never pushed automatically.** Repricing a live
  plan changes what existing subscribers are billed, so it is never a side
  effect of a sync noticing a mismatch. It *is* possible, as an explicit
  operator action: `PUT …/plans/price` reprices the provider plan **and** the
  catalog together, using the same code path, so the advertised price and the
  billed price cannot be left disagreeing. The provider is updated first — if
  that fails, the catalog is not written, so a failed change leaves the
  deployment charging what it charged before rather than advertising a price it
  cannot bill.
- **A reset is a price change, not a deletion of the override.** Dropping the
  stored override would revert the catalog to the configured amount while the
  provider plan kept billing the overridden one; `DELETE …/plans/price/:tier`
  therefore pushes the configured amount through the same update.
- **Overrides carry the amount only, never the currency.** Which tiers are
  purchasable and in which currency stays deployment configuration, so a
  deployment cannot end up half-priced in one currency and half in another.
- **A plan we did not create is never adopted.** A hand-made plan is left alone.
- **An archived plan is replaced, and the replacement is reported.** A plan can
  only be recognised as ours by the tag in its metadata, so a plan that a delete
  archived — the provider's substitute for deleting a plan that billing history
  references — would keep matching that tag and be reused forever, leaving the
  tier unsellable. Syncing creates a replacement and names the plan it replaced.
- **A deactivated plan is left alone.** Unlike an archive, `inactive` is a
  decision someone made. Creating a second plan over it would override that, so
  it is reported and nothing is created.

The merchant id is derived from the app record. `merchants.list` is *not* usable
for this — verified live, it returns child merchants under the account rather
than the caller.

> **Recurring activation:** the first checkout is one-off; once its webhook has
> granted the plan, `services/recurring.ts` starts a subscription against the
> same tier's plan using the saved card. The plan carries a 30-day trial equal
> to the already-paid period, which is what prevents a double first charge. A
> failure leaves the paid month intact and is reported (`no_saved_card`,
> `no_customer`, `plan_not_sellable`) instead of silently enabling auto-renew.
>
> **Unverified:** whether OpenPay reprices a subscription that is already in
> flight when its plan's amount changes, or keeps the amount it was created
> with. It cannot be checked from here while subscriptions cannot be created
> (see *Still open*), so the admin control says so rather than implying either
> behaviour is guaranteed. Treat a price change as certain for *new* customers
> only.
- **An archived plan is replaced, and the replacement is reported.** A plan can
  only be recognised as ours by the tag in its metadata, so a plan that a delete
  archived — the provider's substitute for deleting a plan that billing history
  references — would keep matching that tag and be reused forever, leaving the
  tier unsellable. Syncing creates a replacement and names the plan it replaced.
- **A deactivated plan is left alone.** Unlike an archive, `inactive` is a
  decision someone made. Creating a second plan over it would override that, so
  it is reported and nothing is created.

The merchant id is derived from the app record. `merchants.list` is *not* usable
for this — verified live, it returns child merchants under the account rather
than the caller.

> **Symptom to know about:** an `instanceof` brand check on the provider SDK's
> error class failed here because the controller resolved a *different copy* of
> the SDK than the tests did — `apps/controller` pinned `^0.0.5` while the root
> pinned `^0.0.6`, so npm installed a second copy under
> `apps/controller/node_modules`. The error mapping duck-types the HTTP status
> instead of relying on class identity, and the two declarations are now kept in
> step (both on `^0.0.11`). Check `ls apps/controller/node_modules/@fiatden` if an
> SDK type starts behaving strangely.

### Still open

| Gap | Impact | Why / where |
|---|---|---|
| **Live recurring charge not observed yet** | code now starts a monthly subscription from the card saved by the first checkout, with a 30-day trial so the paid month is not charged twice; the provider account still has to be able to take money | The recurring path is covered with a stubbed provider (`recurring-activation.test.ts`), and the existing webhook tests cover `subscription.renewed` / `failed` / `paused`. It has not been exercised against the live merchant because `checkout.create` still returns `502 provider_channel_inactive` — `kyc_status: pending` and no settlement account. Once that account is enabled, watch the first activation: it calls `customers.paymentMethods` and then `subscriptions.create` with `trial_days: 30`. If the provider does not save a reusable card, activation reports `no_saved_card` instead of pretending auto-renew is on. |
| **iOS verified in CI only** | Linux release and Android debug APK are built and verified locally; iOS needs macOS + Xcode so it is built by `ios-verification` in CI with `--no-codesign` (compile verification, not signing) | an Apple team identity is required to sign a real build |
| **Single workspace** | `app_id` scoping unused; one app (`Core`) exists and plans inherit it | OpenPay `apps` |
| **No node-operator payouts** | operators are paid out of band | OpenPay `payouts` — a product decision, not a defect |
| **No disputes view in the dashboard** | a chargeback must be answered with curl before the provider's deadline | the API is complete and tested (`routes/disputes.ts`); only the dashboard views are missing |
| **No admin audit log** | a price change or settings write records the acting admin in the row it wrote, but node edits, deletions and refunds record nothing | there is no `admin_audit_log` table |
| **Node-agent internals are untested** | a regression in `agent.ts`, `usage.ts` or `controller-client.ts` is not caught by `npm test` | no test imports them; `npm run server:smoke` exercises them end to end against a running controller |

### Provider contract facts

Verified against the live provider and the SDK, not inferred. Recorded because
each one changed a decision:

| Fact | Consequence |
|---|---|
| `Dispute.status` is the verdict (`won`/`lost`/`resolved`) | dispute outcomes can be applied; `resolved` means "closed, no verdict" |
| `PlanCreateParams` requires `merchant_id` | it must be derived; `merchants.list` returns *child* merchants, so the app record is used instead |
| `PlanCreateParams` omits `metadata`, but the API stores it | the tier tag is cast through rather than dropped; discovery depends on it |
| `subscriptions.deletePlan` exists from SDK 0.0.6 | plans can be cleaned up; a delete leaves an *archived* plan when history references it |
| The controller pinned `^0.0.5` while the root pinned `^0.0.6` | npm installed a second SDK copy for the controller, which is why `instanceof OpenPayError` failed; both now declare `^0.0.11` |
| `deletePlan` archives rather than deletes when referenced | archived plans are replaced on the next sync, and the replacement is reported |
| `charges.tokenize` is not a separate blocker | the stored key is accepted; tokenize's failure is downstream of routing, not a second credential problem. SDK 0.0.11 keeps `TokenizeParams.plan_id`, but the product uses the card saved by hosted checkout instead of a second card-capture surface |
| `providers.validateConfig`/`getReadiness`/`getHealth` separate our key from the account | they answer different questions, and they disagree in a way that matters. `validateConfig('saved')` checks the key against the provider's bank list and can report `credentials_valid` — and `listConfigs().connection_status: valid` with it — while `getReadiness().credentials` reports `unreachable` and `health` reports `available: false`. A green key check does **not** mean the account can take money. The panel labels them "key check" and "routing" for exactly that reason. |
| A failing account makes a *valid* key unroutable | the router refuses a provider once recent failures exceed its threshold, and says so: `recent platform failures exceed the routing threshold and these credentials are unverified`. `validateConfig({source:'saved', update_saved_status:true})` is what the provider asks for to clear that stale history, and it is what the **Test connection** button does — but it only helps if the account can then pass. |
| An unroutable provider sends other calls to the next provider | with paystack unavailable, `charges.tokenize` stopped returning a 401 and started returning `No active korapay provider configuration for this merchant` — the router had moved on to an unconfigured provider, so the error names the wrong thing. Read it as "no provider could take this", not "korapay is missing". |
| A Paystack account with no active channel rejects every charge regardless of the `channel` requested | `channel: 'card' | 'bank' | 'ussd' | 'qr'` all return `No active channel to process transaction`, so this is an account setting, not a per-call choice |
| Passing `app_id`/`merchant_id` explicitly does not change provider selection here | the API key is already app-scoped, so a failure cannot be blamed on a missing workspace scope |
| A provider 401/403 means *our* key is wrong, not the caller's | mapped to 502 rather than echoed: the admin dashboard signs an operator out on any 401/403 from this API, so echoing it would log them out mid-session over our own misconfiguration |

One observation about the provider's API, not our code: `merchants.list` returns
`password_hash` for each merchant. That is the provider leaking a credential
field over the API and is worth raising with them.

### Account recovery

The auth surface used to be register/login/refresh/logout only, which meant a
user who forgot their password was locked out permanently. It now also covers:

| Route | Purpose |
|---|---|
| `POST /api/v1/auth/password/forgot` | starts a reset; always 202 with an identical body, so it is not an account-existence oracle |
| `POST /api/v1/auth/password/reset` | consumes a token and sets a new password |
| `POST /api/v1/auth/password/change` | signed-in user changes their own password |
| `DELETE /api/v1/me` | self-service deletion, requiring the current password |
| `POST /api/v1/admin/users/:userId/password-reset` | operator-issued reset token to hand over out of band |
| `POST /api/v1/admin/billing/refund` | the refund the payment docs describe; a full refund also revokes access |

Reset tokens are single-use, expire after 30 minutes, are superseded by a newer
issue, and sign out every other session and node credential — so an intercepted
link cannot leave an attacker holding a live refresh token or a working tunnel.

The client now surfaces both self-service paths. **Forgot password?** on the sign-in
screen opens `password_reset_screen.dart`, which asks the controller to email a
link and, in the same screen, accepts the code (or a whole pasted link, from which
it extracts the token) when mail is not configured and an operator relays one.
Deletion lives in the account screen's danger zone and confirms with the password,
so a stolen access token alone cannot destroy the account. `test/account_recovery_test.dart`
pins the contract, including that a *rejected* deletion leaves the local session
intact.

## Testing map

Run `npm test` (unit + integration). Integration boots real Postgres and Redis
via testcontainers, so it needs Docker.

| Suite | Covers |
|---|---|
| `test/unit/crypto.test.ts` | HMAC signing strings, Ed25519 canonical JSON, key-cache correctness |
| `test/unit/openpay.test.ts` | signature parsing/verification, event mapping, gateway error translation |
| `test/unit/policy.test.ts` | tier catalogue, load scoring, node ranking |
| `test/unit/admin-ui.test.ts` | every dashboard view rendered and every button fired, via a DOM shim |
| `test/unit/production-config.test.ts` | the boot guard: production refuses `CORS_ORIGINS=*` and a `localhost` `PUBLIC_APP_URL`, warns on the rest, and leaves development alone |
| `test/integration/auth.test.ts` | register/login/refresh rotation/logout/seats, including that logout revokes the refresh token |
| `test/integration/admin.test.ts` | the admin authorization matrix over every admin route |
| `test/integration/fleet.test.ts` | enrollment, HMAC internal API, nonce replay, usage isolation |
| `test/integration/network.test.ts` | signed bundles, load-aware assignment, quota enforcement |
| `test/integration/chargeback.test.ts` | disputes and reversals revoke; partial refunds do not |
| `test/integration/subscription-lifecycle.test.ts` | pay -> lapse -> renew, and status honesty |
| `test/integration/migrations.test.ts` | the committed SQL builds the schema the app expects |
| `test/integration/receipts.test.ts` | receipt access control and provider-outage behaviour |
| `test/integration/admin-billing.test.ts` | the checkout ledger, admin-only and filterable |
| `test/integration/recurring-billing.test.ts` | renewal, pause/resume, cancellation, dunning, idempotency |
| `test/integration/disputes.test.ts` | dispute workflow authorization and validation |
| `test/integration/coupons.test.ts` | coupon validation and failure handling |
| `test/integration/account.test.ts` | password reset/change, account deletion, refunds |
| `test/integration/mail.test.ts` | secret encryption at rest, SMTP settings, delivery outcomes |
| `test/integration/dispute-outcomes.test.ts` | dispute verdicts: restore on a win, never on an ambiguous signal |
| `test/integration/billing-ops.test.ts` | plan provisioning, reuse, price drift, cancellation |
| `test/integration/billing-ops-no-gateway.test.ts` | the operator routes still gate correctly with no gateway |
| `test/integration/pricing.test.ts` | a price change reaches both the provider plan and the next checkout; a failed provider update changes neither |
| `test/unit/admin-spa.test.ts` | build-free dashboard: imports resolve, exports exist, secrets stay write-only |
| `test/unit/openpay-delivery.test.ts` | replays a real captured signed delivery |
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