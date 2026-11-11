import 'package:url_launcher/url_launcher.dart';

/// Opens the payment provider's hosted checkout in the system browser.
///
/// Returns false when the URL is malformed or no browser could be launched, so
/// the caller can show the link instead of leaving the user on a spinner. The
/// app never embeds card details itself; the provider owns that page.
Future<bool> openCheckoutUrl(String rawUrl) async {
  final uri = Uri.tryParse(rawUrl);
  if (uri == null || !uri.hasScheme || uri.host.isEmpty) return false;
  try {
    return await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    // Missing platform implementation, blocked intent, or no handler.
    return false;
  }
}
