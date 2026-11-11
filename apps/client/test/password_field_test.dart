import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/core/widgets/password_field.dart';

void main() {
  testWidgets('a password field hides its text until revealed', (tester) async {
    final controller =
        TextEditingController(text: 'correct horse battery staple');
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: PasswordField(controller: controller))),
    );

    // The visibility flag lives on the TextField the form field builds.
    TextField textField() => tester.widget<TextField>(
          find.descendant(
            of: find.byType(PasswordField),
            matching: find.byType(TextField),
          ),
        );

    expect(textField().obscureText, isTrue, reason: 'passwords start hidden');
    expect(find.byTooltip('Show password'), findsOneWidget);

    await tester.tap(find.byTooltip('Show password'));
    await tester.pump();

    expect(textField().obscureText, isFalse,
        reason: 'the toggle reveals the value');
    expect(find.byTooltip('Hide password'), findsOneWidget);
    expect(controller.text, 'correct horse battery staple',
        reason: 'toggling must not edit the value');

    await tester.tap(find.byTooltip('Hide password'));
    await tester.pump();

    expect(textField().obscureText, isTrue,
        reason: 'the value can be hidden again');
  });
}
