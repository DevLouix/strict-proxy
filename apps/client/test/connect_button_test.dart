import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/features/home/application/connection_controller.dart';
import 'package:strict_proxy_client/features/home/presentation/home_screen.dart';

/// The animation must never be the only thing reporting what happened: while
/// connecting a progress ring is always present, and leaving that state stops
/// the repeating halo — a loop that outlives its state also hangs every widget
/// test that waits for the tree to settle.
void main() {
  // The MediaQuery sits inside MaterialApp: the app installs its own from the
  // test view, so an override wrapped around it is discarded.
  Widget wrap(
    Object state, {
    VoidCallback? onTap,
    bool disableAnimations = false,
  }) =>
      MaterialApp(
        home: Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(disableAnimations: disableAnimations),
            child: Scaffold(
              body: Center(
                child: ConnectButton(state: state, onTap: onTap ?? () {}),
              ),
            ),
          ),
        ),
      );

  testWidgets('a tap is reported and the connecting state shows progress',
      (tester) async {
    var taps = 0;
    await tester.pumpWidget(wrap(const EngineStateIdle(), onTap: () => taps += 1));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byIcon(Icons.power_settings_new), findsOneWidget);
    await tester.tap(find.byType(ConnectButton));
    await tester.pump(const Duration(milliseconds: 150));
    expect(taps, 1);

    await tester.pumpWidget(wrap(const EngineStateConnecting()));
    await tester.pump(const Duration(milliseconds: 350));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    await tester.pumpWidget(wrap(const EngineStateError('the engine refused')));
    // This only finishes if the repeating animation was stopped on the way out.
    await tester.pumpAndSettle();
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.byIcon(Icons.power_settings_new), findsOneWidget);
  });

  testWidgets('a disabled-animations device drops the repeating halo',
      (tester) async {
    await tester.pumpWidget(
      wrap(const EngineStateConnecting(), disableAnimations: true),
    );
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const ValueKey('connect-halo')), findsNothing);
    expect(find.byType(ConnectButton), findsOneWidget);

    // The same state without the preference does build the halo, so the check
    // above is about the setting and not about the halo never existing.
    await tester.pumpWidget(wrap(const EngineStateConnecting()));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const ValueKey('connect-halo')), findsOneWidget);
  });
}
