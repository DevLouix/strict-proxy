import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api_client.dart';
import '../../../core/billing_models.dart';
import '../../auth/presentation/auth_controller.dart';

/// Async state for the account/billing screen.
class BillingState {
  const BillingState({
    this.loading = false,
    this.startingCheckout = false,
    this.catalog,
    this.subscription,
    this.usage,
    this.error,
    this.checkout,
  });

  final bool loading;
  final bool startingCheckout;
  final BillingCatalog? catalog;
  final SubscriptionSummary? subscription;
  final UsageReport? usage;
  final String? error;

  /// Set once a checkout session exists; the UI opens it and then clears it.
  final CheckoutSession? checkout;

  bool get hasData => subscription != null;

  BillingState copyWith({
    Object? loading = _unset,
    Object? startingCheckout = _unset,
    Object? catalog = _unset,
    Object? subscription = _unset,
    Object? usage = _unset,
    Object? error = _unset,
    Object? checkout = _unset,
  }) =>
      BillingState(
        loading: identical(loading, _unset) ? this.loading : loading as bool,
        startingCheckout: identical(startingCheckout, _unset) ? this.startingCheckout : startingCheckout as bool,
        catalog: identical(catalog, _unset) ? this.catalog : catalog as BillingCatalog?,
        subscription: identical(subscription, _unset) ? this.subscription : subscription as SubscriptionSummary?,
        usage: identical(usage, _unset) ? this.usage : usage as UsageReport?,
        error: identical(error, _unset) ? this.error : error as String?,
        checkout: identical(checkout, _unset) ? this.checkout : checkout as CheckoutSession?,
      );

  static const _unset = Object();
}

final billingProvider = StateNotifierProvider<BillingController, BillingState>((ref) => BillingController(ref));

class BillingController extends StateNotifier<BillingState> {
  BillingController(this._ref) : super(const BillingState());

  final Ref _ref;

  /// One automatic attempt per account/session. A manual retry can reset it.
  bool _autoRenewAttempted = false;

  ControllerApi get _api => _ref.read(apiProvider);

  /// Loads subscription, catalog and usage together.
  ///
  /// The catalog is best-effort: a deployment without a gateway configured
  /// should still show the user's plan, just without upgrade buttons.
  Future<void> load() async {
    state = state.copyWith(loading: true, error: null);
    try {
      final subscription = await _api.subscription();
      UsageReport? usage;
      try {
        usage = await _api.usage();
      } on ApiException {
        usage = null;
      }
      BillingCatalog? catalog;
      try {
        catalog = await _api.billingCatalog();
      } on ApiException {
        catalog = null;
      }
      state = state.copyWith(loading: false, subscription: subscription, usage: usage, catalog: catalog);
      await _tryEnableAutoRenew(subscription);
    } on ApiException catch (e) {
      state = state.copyWith(loading: false, error: e.message);
    } catch (e) {
      state = state.copyWith(loading: false, error: 'Could not load your subscription: $e');
    }
  }

  /// Opens a checkout for [tier].
  ///
  /// Returns the provider's hosted URL, or null when the checkout could not be
  /// opened; the reason is then in `state.error`. Returning an error message as
  /// if it were a URL is how a "pay" button ends up opening nothing.
  Future<String?> startCheckout(String tier) async {
    if (state.startingCheckout) return null;
    state = state.copyWith(startingCheckout: true, error: null);
    try {
      final session = await _api.createCheckout(tier);
      state = state.copyWith(startingCheckout: false, checkout: session);
      return session.checkoutUrl;
    } on ApiException catch (e) {
      state = state.copyWith(startingCheckout: false, error: e.message);
      return null;
    } catch (e) {
      state = state.copyWith(startingCheckout: false, error: 'Could not start checkout: $e');
      return null;
    }
  }

  /// Clears the pending checkout once the UI has acted on it.
  void consumeCheckout() => state = state.copyWith(checkout: null);

  /// Turns the card saved by the first payment into a monthly subscription.
  ///
  /// Runs once per load for an active paid account whose provider subscription
  /// is not attached yet. This is what makes the first purchase recur; it is
  /// safe to call repeatedly because the server is idempotent.
  Future<void> _tryEnableAutoRenew(SubscriptionSummary subscription) async {
    if (_autoRenewAttempted || !subscription.hasActivePaidPlan || subscription.autoRenew) return;
    _autoRenewAttempted = true;
    try {
      final reason = await _api.activateRecurring();
      if (reason == null) {
        final refreshed = await _api.subscription();
        state = state.copyWith(subscription: refreshed);
      } else {
        state = state.copyWith(error: reason);
      }
    } on ApiException catch (e) {
      state = state.copyWith(error: e.message);
    } catch (e) {
      state = state.copyWith(error: 'Auto-renew could not be enabled: $e');
    }
  }

  /// Retries auto-renew after the automatic attempt failed.
  Future<void> enableAutoRenew() async {
    _autoRenewAttempted = false;
    await load();
  }

  /// Drops every loaded value so the next account cannot inherit them.
  void reset() {
    _autoRenewAttempted = false;
    state = const BillingState();
  }

  void clearError() => state = state.copyWith(error: null);
}