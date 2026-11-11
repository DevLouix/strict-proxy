# Client & admin audit

An audit of what the product can already do server-side versus what the two
operator/user surfaces expose, ordered by revenue risk and support load rather
than by volume of missing UI. Line references are omitted deliberately: this is
a map of gaps, not a review of any one commit.

## Summary

The controller is ahead of its interfaces. Several workflows are fully
implemented — dispute evidence, refunds, operator password reset, receipts,
coupons — but have no control in the dashboard or the client, so they exist only
for whoever is willing to curl the API by hand.

Two classes of gap stand out:

1. **Money that is lost by default.** A chargeback revokes access automatically,
   but filing evidence required a manual API call. Refunds had no UI at all.
2. **Sessions that outlive their right to.** The client's session-expiry hook was
   empty and signing out left the tunnel running.

## Fixed in this pass

| Gap | Change |
| --- | --- |
| Disputes had no dashboard | New **Disputes** tab (`disputes-view.js`): status filter, amount at stake, per-dispute detail, evidence history, evidence filing, and manual "mark filed" for providers without an evidence API. |
| Refunds had no control | The Payments ledger now has a **Refund** action on settled checkouts: full or partial amount, a reason, and a statement of the access consequence before it is issued. |
| Operator actions were unattributed | New **Audit log** tab backed by `admin_audit_log`: user changes, subscription changes, refunds, price and plan changes, subscription cancellations, node edits/deletes, enrollment issue/rotate/revoke, release publish/delete, and reset-token issuance. |
| Users had no detail view | **Details** in the users table opens the subscription, devices, node credentials, payments, recent operator actions, and an issue-password-reset control. |
| Client ignored session expiry | `ControllerApi.onSessionExpired` fires when a 401 cannot be refreshed; `AuthController` clears local tokens and leaves the authenticated state, so the gate shows sign-in. |
| Signing out left the tunnel up | The app-level auth listener disconnects the engine whenever the session goes from authenticated to unauthenticated — on explicit logout, account deletion, or expiry. |
| Nodes could only be drained | **Edit** in the fleet table now changes hostname, region, label, public IP and tunnel port, and records the change in the audit log. |
| A node secret leak meant re-enrollment | **Rotate secret** issues a new HMAC secret in place, with an optional grace window during which the old one still verifies. The agent now names rotation in its 401 error, and the install script repairs a broken VPS resolver before enrolling. |

## Admin panel

### Routes that exist but had no UI

| Capability | Routes | State |
| --- | --- | --- |
| Disputes / chargebacks | `GET /api/v1/admin/disputes`, `GET …/:id`, evidence `GET`/`POST`, mark submitted | **Now in the dashboard** |
| Refunds | `POST /api/v1/admin/billing/refund` | **Now in the Payments ledger.** Full or partial, with a reason and the access consequence stated before it is issued. |
| Operator password reset | `POST /api/v1/admin/users/:userId/password-reset` | **Now in the user detail drawer**, with the one-time token shown once and a copy control. |
| User detail | `GET /api/v1/admin/users/:userId` | **Now in the dashboard**, returning subscription, devices, credentials, checkouts and recent operator actions. |
| Receipts | `GET /api/v1/billing/receipt/:reference` | Unused by both surfaces. |

### Missing entirely

- **Admin 2FA, IP allowlist, session revocation.** One password is the whole
  perimeter of a panel that can revoke every customer.
- **Pagination and server-side search.** Users cap at 200, events at 500,
  enrollments at 200, checkouts at 500, all filtered in memory. The first page is
  the only page.
- **Per-user and per-node bandwidth analytics.** `usage_rollups` and
  `node_credentials.bytes_used` exist; the Usage tab shows load score and
  checkout counts instead.
- **Node history.** Nodes can now be edited, but there is no per-node timeline
  of changes; the audit log records who changed one, not a side-by-side diff.
- **Crash triage.** Crashes are listed with no grouping, filtering, or
  acknowledge/resolve state.
- **Per-ABI withdraw and staged rollout.** Publishing and withdrawing act on a
  whole build.

### Code-level issues

- `enrollmentsView` awaited `nodesView(api)` and discarded the result — a wasted
  request on every load of the tab.
- `usersView` re-fetches everything on each keystroke of the filter box because
  filtering and rendering are coupled.
- Payments, usage and overview each fetch the billing summary independently; no
  shared cache, so one page can show three different snapshots.

## Client

### Correctness

- ~~Empty `ref.listen(authStateProvider, …)` in `main.dart`~~ — fixed; a dead
  refresh token now returns the user to sign-in.
- ~~`AuthController.logout()` cleared tokens but never disconnected~~ — fixed by
  the app-level auth listener.
- `servers_screen.dart` swallows probe failures (`catch (_)`), so a network error
  renders as "no servers" instead of a retryable message.
- `billing_models.dart` parses `pendingCheckout`; no screen uses it, so a user
  with an abandoned checkout is never told to finish it.

### Missing features

- **Coupons.** Checkout accepts `couponCode`; the paywall has no field for it.
- **Receipts.** No way to download an invoice from the account screen.
- **Change password.** `POST /api/v1/auth/password/change` exists; only the
  forgot-password flow is wired.
- **Device management.** The account screen shows a seat count but not the
  devices occupying the seats, and cannot revoke one.
- **Connection telemetry.** No session timer, throughput, or data-used display on
  the home screen.
- **Auto-connect and kill switch.** Both are expected of a VPN client and neither
  exists.
- **Diagnostics export.** Support requests arrive with no logs attached.
- **Status and support.** No in-app link to service status, and no support entry
  point beyond email.
- **Pre-renewal messaging.** No notice before a subscription renews or expires.
- **iOS.** The engine adapter exists, but update delivery and the docs cover
  Android and Linux only.

## Priority order

1. **Disputes UI** — done.
2. **Refund action** with amount, reason, and an explicit statement that a full
   refund revokes access — done.
3. **Admin audit log** for every destructive action — done.
4. **Session-expiry redirect and disconnect-on-logout** — done.
5. **Admin user detail drawer** (devices, credentials, payments, password reset) — done.
6. **Node editing and in-place HMAC rotation** — done.
7. **Admin 2FA / IP allowlist / session revocation** — open.
8. **Client self-service bundle:** device list and revocation, receipts, change
   password, coupon field, pending-checkout prompt.

## Verification

Server-side checks after the disputes UI change:

```bash
npm run typecheck
npm run test:unit
node --import tsx --test test/integration/admin.test.ts
```

The Flutter client is checked with the SDK installed in the repo-local
`.flutter-sdk/` directory (git-ignored):

```bash
cd apps/client
flutter analyze
flutter test
```
