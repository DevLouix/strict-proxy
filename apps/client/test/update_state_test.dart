import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/features/updates/update_controller.dart';

void main() {
  test('copyWith accepts an int progress without throwing', () {
    // `progress: 0` in downloadAndInstall crashed the installer with
    // "type 'int' is not a subtype of type 'double?'" before this.
    final next = const UpdateState().copyWith(progress: 0);
    expect(next.progress, 0.0);
  });

  test('copyWith can still clear progress and error', () {
    final next = const UpdateState(progress: 0.5, error: 'failed')
        .copyWith(progress: null, error: null);
    expect(next.progress, isNull);
    expect(next.error, isNull);
  });
}

  test('a refusal is recorded on the state and survives a copy', () {
    final next = const UpdateState().copyWith(
      required: true,
      requiredMessage: 'Update to build 80 or newer.',
    );
    expect(next.required, isTrue);
    expect(next.requiredMessage, 'Update to build 80 or newer.');
    expect(next.hasUpdate, isFalse);
  });
