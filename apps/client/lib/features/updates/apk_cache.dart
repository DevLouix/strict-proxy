/// Naming and inspection of the APK cached for an in-app update.
///
/// The download is written to the app's cache directory and named for the
/// build and ABI it belongs to, which is what lets a later attempt tell "this
/// is the update I started" apart from "this is some other file".
library;

/// Cache file name for one update's APK.
String apkFileName(int buildNumber, String abi) => 'strict-proxy-$buildNumber-$abi.apk';

/// True when [bytesOnDisk] is a finished download of the published APK.
///
/// [expectedBytes] comes from the release feed; zero means it was not
/// published, in which case any non-empty file is accepted rather than forcing
/// a permanent re-download.
bool isCompleteDownload(int bytesOnDisk, int expectedBytes) =>
    bytesOnDisk > 0 && (expectedBytes <= 0 || bytesOnDisk == expectedBytes);

/// The byte offset a download of this file should resume from.
///
/// A partial file is a prefix of the APK, so the server can continue from its
/// length with a range request. A file longer than the published APK is not
/// this update at all — a truncated write cannot grow, so start over.
int resumeOffset(int bytesOnDisk, int expectedBytes) {
  if (bytesOnDisk <= 0) return 0;
  if (expectedBytes > 0 && bytesOnDisk > expectedBytes) return 0;
  return bytesOnDisk;
}
