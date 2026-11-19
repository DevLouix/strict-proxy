import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/features/updates/apk_cache.dart';

void main() {
  test('an update APK is cached under the build and ABI it belongs to', () {
    expect(apkFileName(83, 'arm64-v8a'), 'strict-proxy-83-arm64-v8a.apk');
    expect(
      apkFileName(83, 'arm64-v8a'),
      isNot(apkFileName(84, 'arm64-v8a')),
      reason: 'a new build must not reuse the previous build\'s file',
    );
  });

  test('only a file of the published size is a finished download', () {
    expect(isCompleteDownload(0, 1000), isFalse);
    expect(isCompleteDownload(999, 1000), isFalse, reason: 'a truncated APK cannot be installed');
    expect(isCompleteDownload(1000, 1000), isTrue);
    expect(isCompleteDownload(1000, 0), isTrue, reason: 'the feed did not publish a size');
  });

  test('a partial file resumes, an oversized one starts over', () {
    expect(resumeOffset(0, 1000), 0);
    expect(resumeOffset(400, 1000), 400);
    expect(resumeOffset(1200, 1000), 0, reason: 'longer than the APK means it is not this APK');
    expect(resumeOffset(400, 0), 400);
  });
}
