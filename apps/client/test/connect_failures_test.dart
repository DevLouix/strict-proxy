import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/core/api_client.dart';
import 'package:strict_proxy_client/features/home/application/connection_controller.dart';

/// These messages are the difference between a user understanding why their
/// tunnel dropped and staring at "ApiException(402, SUBSCRIPTION_REQUIRED)".
void main() {
  String describe(int status, String code, [String message = 'boom']) =>
      ConnectionNotifier.describeConnectFailureForTest(ApiException(status, code, message));

  test('an expired subscription tells the user to renew', () {
    expect(describe(402, 'SUBSCRIPTION_REQUIRED'), 'Your subscription has expired. Renew it to reconnect.');
  });

  test('an exhausted quota tells the user to upgrade', () {
    expect(describe(402, 'BANDWIDTH_QUOTA_EXCEEDED'), 'You have used your data allowance. Upgrade to reconnect.');
  });

  test('an empty fleet is reported as temporary, not fatal', () {
    expect(describe(400, 'NO_NODES_AVAILABLE'), 'No servers are available right now. Try again shortly.');
  });

  test('every session-ended code tells the user to sign in again', () {
    for (final code in ['TOKEN_REVOKED', 'UNAUTHENTICATED', 'INVALID_REFRESH', 'ACCOUNT_UNAVAILABLE']) {
      expect(describe(401, code), 'Your session has ended. Sign in again to reconnect.', reason: code);
    }
  });

  test('an unreachable controller reads as a connectivity problem', () {
    expect(describe(0, 'NETWORK_ERROR'), 'Cannot reach the controller. Check your connection.');
  });

  test('an unrecognised error still shows the server message', () {
    expect(describe(500, 'INTERNAL', 'something specific'), 'something specific');
  });
}