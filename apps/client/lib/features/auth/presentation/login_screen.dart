import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';

import '../../../core/widgets/password_field.dart';
import 'auth_controller.dart';
import 'password_reset_screen.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _passwordFocus = FocusNode();
  bool _isRegister = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final auth = ref.read(authStateProvider.notifier);
    final err = _isRegister
        ? await auth.register(_email.text.trim(), _password.text)
        : await auth.login(_email.text.trim(), _password.text);
    if (err == null) {
      // The credentials just worked; let the platform password manager store or
      // update them instead of treating this as a one-off form.
      TextInput.finishAutofillContext(shouldSave: true);
    }
    if (mounted) {
      setState(() {
        _busy = false;
        _error = err;
      });
    }
  }

  void _openReset() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const PasswordResetScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: AutofillGroup(
              child: Form(
                key: _formKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Icon(Icons.shield_outlined, size: 72),
                    const SizedBox(height: 8),
                    Text(
                      'StrictProxy',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 32),
                    TextFormField(
                      controller: _email,
                      enabled: !_busy,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.email],
                      autocorrect: false,
                      textCapitalization: TextCapitalization.none,
                      decoration: const InputDecoration(labelText: 'Email'),
                      onFieldSubmitted: (_) => _passwordFocus.requestFocus(),
                      validator: (v) => (v == null || !v.contains('@'))
                          ? 'Enter a valid email'
                          : null,
                    ),
                    const SizedBox(height: 12),
                    PasswordField(
                      controller: _password,
                      focusNode: _passwordFocus,
                      enabled: !_busy,
                      helperText: 'At least 10 characters',
                      autofillHints: [
                        _isRegister
                            ? AutofillHints.newPassword
                            : AutofillHints.password,
                      ],
                      onFieldSubmitted: (_) {
                        if (!_busy) _submit();
                      },
                      validator: (v) => (v == null || v.length < 10)
                          ? 'At least 10 characters'
                          : null,
                    ),
                    const SizedBox(height: 24),
                    if (_error != null) ...[
                      Text(_error!,
                          style: const TextStyle(color: Colors.redAccent)),
                      const SizedBox(height: 12),
                    ],
                    FilledButton(
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2))
                          : Text(_isRegister ? 'Create account' : 'Sign in'),
                    ),
                    TextButton(
                      onPressed: _busy
                          ? null
                          : () => setState(() => _isRegister = !_isRegister),
                      child: Text(_isRegister
                          ? 'Already have an account? Sign in'
                          : 'No account? Create one'),
                    ),
                    TextButton(
                      // Only useful when signing in; hidden while registering so
                      // the screen does not offer to recover an account the user
                      // is in the middle of creating.
                      onPressed: _busy || _isRegister ? null : _openReset,
                      child: const Text('Forgot password?'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
