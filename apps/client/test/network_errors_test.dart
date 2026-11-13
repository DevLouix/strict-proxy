// A phone with no connection used to put `ClientException with SocketException:
// Failed host lookup ... errno = 7` under the sign-in form. These pin the
// customer-facing wording that replaced it.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:strict_proxy_client/core/api_client.dart';

void main() {
  const unreachable =
      'Cannot reach StrictProxy. Check your internet connection and try again.';

  test('a failed DNS lookup reads as a connectivity problem', () {
    final error = http.ClientException(
      "Failed host lookup: 'strictproxyapi.devlouix.com' "
      '(OS Error: No address associated with hostname, errno = 7)',
      Uri.parse('https://strictproxyapi.devlouix.com/api/v1/auth/login'),
    );

    expect(ControllerApi.describeNetworkErrorForTest(error), unreachable);
    expect(
      ControllerApi.describeNetworkErrorForTest(error),
      isNot(contains('errno')),
    );
  });

  test('a refused connection reads the same way', () {
    final error = http.ClientException(
      'Connection refused',
      Uri.parse('https://strictproxyapi.devlouix.com/api/v1/auth/login'),
    );

    expect(ControllerApi.describeNetworkErrorForTest(error), unreachable);
  });

  test('a timeout says the server took too long', () {
    expect(
      ControllerApi.describeNetworkErrorForTest(TimeoutException('slow')),
      'StrictProxy took too long to respond. Try again.',
    );
  });
}
