import 'package:flutter/material.dart';

/// A password input with a reveal control.
///
/// Every place the client asks for a secret uses this instead of a bare
/// `TextFormField`, so autocorrect, capitalization and suggestions stay off and
/// the value can still be checked for typos before submitting. The reveal
/// control is a normal button with a tooltip, so it is reachable by screen
/// readers and predicts its next action.
class PasswordField extends StatefulWidget {
  const PasswordField({
    super.key,
    required this.controller,
    this.label = 'Password',
    this.helperText,
    this.validator,
    this.textInputAction = TextInputAction.done,
    this.onFieldSubmitted,
    this.autofillHints,
    this.focusNode,
    this.autofocus = false,
    this.enabled = true,
  });

  final TextEditingController controller;
  final String label;
  final String? helperText;
  final String? Function(String?)? validator;
  final TextInputAction textInputAction;
  final ValueChanged<String>? onFieldSubmitted;
  final Iterable<String>? autofillHints;
  final FocusNode? focusNode;
  final bool autofocus;
  final bool enabled;

  @override
  State<PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<PasswordField> {
  bool _obscured = true;

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: widget.controller,
      focusNode: widget.focusNode,
      enabled: widget.enabled,
      autofocus: widget.autofocus,
      obscureText: _obscured,
      // A password is not prose: suggestions and autocorrect both get in the
      // way and can leak what is being typed into the keyboard's dictionary.
      autocorrect: false,
      enableSuggestions: false,
      textCapitalization: TextCapitalization.none,
      keyboardType: TextInputType.visiblePassword,
      textInputAction: widget.textInputAction,
      autofillHints: widget.autofillHints,
      validator: widget.validator,
      onFieldSubmitted: widget.onFieldSubmitted,
      decoration: InputDecoration(
        labelText: widget.label,
        helperText: widget.helperText,
        suffixIcon: IconButton(
          tooltip: _obscured ? 'Show password' : 'Hide password',
          onPressed: widget.enabled
              ? () => setState(() => _obscured = !_obscured)
              : null,
          icon: Icon(
            _obscured
                ? Icons.visibility_outlined
                : Icons.visibility_off_outlined,
          ),
        ),
      ),
    );
  }
}
