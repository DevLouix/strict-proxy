import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/main.dart';

void main() {
  testWidgets('StrictProxy app renders', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: StrictProxyApp()));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(MaterialApp), findsOneWidget);
    expect(find.text('StrictProxy'), findsNothing);
  });
}
