import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';

import '../../../core/widgets/password_field.dart';
import 'auth_controller.dart';

/// Password recovery: request a reset link, then set a new password with the
/// code it carries.
///
/// The two halves live on one screen because they are one task to the user, and
/// because the code can also arrive from an operator when the deployment has no
/// mail transport configured — in that case there is no link to follow, only a
/// code to paste. Accepting the whole link as well as the bare code covers both
/// without needing per-platform deep-link plumbing.
class PasswordResetScreen extends ConsumerStatefulWidget {
  const PasswordResetScreen({super.key});

  @override
  ConsumerState<PasswordResetScreen> createState() =>
      _PasswordResetScreenState();
}

class _PasswordResetScreenState extends ConsumerState<PasswordResetScreen> {
  final _emailForm = GlobalKey<FormState>();
  final _resetForm = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _code = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  final _passwordFocus = FocusNode();
  final _confirmFocus = FocusNode();

  bool _sending = false;
  bool _resetting = false;
  bool _linkSent = false;
  String? _requestError;
  String? _resetError;

  @override
  void dispose() {
    _email.dispose();
    _code.dispose();
    _password.dispose();
    _confirm.dispose();
    _passwordFocus.dispose();
    _confirmFocus.dispose();
    super.dispose();
  }

  /// A reset link carries the token as a query parameter; a relayed code is the
  /// token by itself. Return whichever the user pasted.
  String _tokenFrom(String input) {
    final trimmed = input.trim();
    if (trimmed.isEmpty) return '';
    if (!trimmed.contains('token=')) return trimmed;
    final parsed = Uri.tryParse(trimmed)?.queryParameters['token'];
    if (parsed != null && parsed.isNotEmpty) return parsed;
    // Fall back to a manual scan for a link that is not a well-formed URI.
    final match = RegExp(r'token=([^&\s]+)').firstMatch(trimmed);
    return match == null ? trimmed : Uri.decodeComponent(match.group(1)!);
  }

  Future<void> _sendLink() async {
    if (!_emailForm.currentState!.validate()) return;
    setState(() {
      _sending = true;
      _requestError = null;
    });
    final err = await ref
        .read(authStateProvider.notifier)
        .requestPasswordReset(_email.text.trim());
    if (!mounted) return;
    setState(() {
      _sending = false;
      _requestError = err;
      // A null error means the request was accepted, not that the address
      // exists; the wording below stays neutral for that reason.
      _linkSent = err == null;
    });
  }

  Future<void> _submitReset() async {
    if (!_resetForm.currentState!.validate()) return;
    setState(() {
      _resetting = true;
      _resetError = null;
    });
    final err = await ref
        .read(authStateProvider.notifier)
        .resetPassword(_tokenFrom(_code.text), _password.text);
    if (!mounted) return;
    setState(() {
      _resetting = false;
      _resetError = err;
    });
    if (err == null) {
      // The new password is now the account's; offer it to the password manager.
      TextInput.finishAutofillContext(shouldSave: true);
      // Success signs out every session server-side, so send the user back to
      // sign in rather than pretending a session still exists.
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('Password updated. Sign in with your new password.')),
      );
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Reset password')),
      body: SafeArea(
        child: AutofillGroup(
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Text('Forgot your password?', style: theme.textTheme.titleLarge),
              const SizedBox(height: 6),
              Text(
                'Enter your email and we will send a reset link. If no message arrives, an operator can give you a reset code instead.',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 16),
              Form(
                key: _emailForm,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextFormField(
                      controller: _email,
                      enabled: !_sending,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.email],
                      autocorrect: false,
                      textCapitalization: TextCapitalization.none,
                      decoration: const InputDecoration(labelText: 'Email'),
                      validator: (v) => (v == null || !v.contains('@'))
                          ? 'Enter a valid email'
                          : null,
                    ),
                    const SizedBox(height: 12),
                    if (_requestError != null) ...[
                      Text(_requestError!,
                          style: const TextStyle(color: Colors.redAccent)),
                      const SizedBox(height: 12),
                    ],
                    if (_linkSent) ...[
                      Text(
                        'If that account exists, a reset link is on its way.',
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: Colors.greenAccent),
                      ),
                      const SizedBox(height: 12),
                    ],
                    FilledButton(
                      onPressed: _sending ? null : _sendLink,
                      child: _sending
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2))
                          : const Text('Email me a reset link'),
                    ),
                  ],
                ),
              ),
              const Divider(height: 48),
              Text('Have a reset code?', style: theme.textTheme.titleMedium),
              const SizedBox(height: 12),
              Form(
                key: _resetForm,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextFormField(
                      controller: _code,
                      enabled: !_resetting,
                      textInputAction: TextInputAction.next,
                      autocorrect: false,
                      textCapitalization: TextCapitalization.none,
                      decoration: const InputDecoration(
                        labelText: 'Reset code or link',
                        helperText:
                            'Paste the code from the email, or the whole link.',
                      ),
                      onFieldSubmitted: (_) => _passwordFocus.requestFocus(),
                      validator: (v) => (v == null || _tokenFrom(v).isEmpty)
                          ? 'Enter the reset code'
                          : null,
                    ),
                    const SizedBox(height: 12),
                    PasswordField(
                      controller: _password,
                      focusNode: _passwordFocus,
                      enabled: !_resetting,
                      label: 'New password',
                      helperText: 'At least 10 characters',
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.newPassword],
                      onFieldSubmitted: (_) => _confirmFocus.requestFocus(),
                      validator: (v) => (v == null || v.length < 10)
                          ? 'At least 10 characters'
                          : null,
                    ),
                    const SizedBox(height: 12),
                    PasswordField(
                      controller: _confirm,
                      focusNode: _confirmFocus,
                      enabled: !_resetting,
                      label: 'Confirm new password',
                      autofillHints: const [AutofillHints.newPassword],
                      onFieldSubmitted: (_) {
                        if (!_resetting) _submitReset();
                      },
                      validator: (v) =>
                          v != _password.text ? 'Passwords do not match' : null,
                    ),
                    const SizedBox(height: 16),
                    if (_resetError != null) ...[
                      Text(_resetError!,
                          style: const TextStyle(color: Colors.redAccent)),
                      const SizedBox(height: 12),
                    ],
                    FilledButton(
                      onPressed: _resetting ? null : _submitReset,
                      child: _resetting
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2))
                          : const Text('Set new password'),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
