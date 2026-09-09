import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/widgets/takeover_card.dart';

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  testWidgets('renders the kind label and detail for a pending takeover',
      (tester) async {
    await tester.pumpWidget(_wrap(TakeoverCard(
      runId: 'run-1',
      kind: 'captcha',
      detail: 'detected captcha page',
      status: 'pending',
      busy: false,
      onTakeOver: () {},
      onDone: () async {},
    )));

    expect(find.text('Needs you: Solve a CAPTCHA'), findsOneWidget);
    expect(find.text('detected captcha page'), findsOneWidget);
    expect(find.byKey(const Key('takeover-take-over')), findsOneWidget);
    expect(find.byKey(const Key('takeover-done')), findsOneWidget);
  });

  testWidgets('labels every known kind distinctly', (tester) async {
    for (final entry in const {
      'two_factor': 'Needs you: Complete two-factor authentication',
      'login_wall': 'Needs you: Sign in',
      'payment': 'Needs you: Confirm a payment',
      'something_unrecognized': 'Needs you: Take a manual step',
    }.entries) {
      await tester.pumpWidget(_wrap(TakeoverCard(
        runId: 'run-1',
        kind: entry.key,
        detail: 'd',
        status: 'pending',
        busy: false,
        onTakeOver: () {},
        onDone: () async {},
      )));
      expect(find.text(entry.value), findsOneWidget, reason: 'kind=${entry.key}');
    }
  });

  testWidgets('Take over invokes the callback', (tester) async {
    var tookOver = false;
    await tester.pumpWidget(_wrap(TakeoverCard(
      runId: 'run-1',
      kind: 'captcha',
      detail: 'd',
      status: 'pending',
      busy: false,
      onTakeOver: () => tookOver = true,
      onDone: () async {},
    )));

    await tester.tap(find.byKey(const Key('takeover-take-over')));
    await tester.pump();

    expect(tookOver, isTrue);
  });

  testWidgets('Done invokes the callback', (tester) async {
    var done = false;
    await tester.pumpWidget(_wrap(TakeoverCard(
      runId: 'run-1',
      kind: 'captcha',
      detail: 'd',
      status: 'pending',
      busy: false,
      onTakeOver: () {},
      onDone: () async {
        done = true;
      },
    )));

    await tester.tap(find.byKey(const Key('takeover-done')));
    await tester.pumpAndSettle();

    expect(done, isTrue);
  });

  testWidgets('busy disables both actions', (tester) async {
    await tester.pumpWidget(_wrap(TakeoverCard(
      runId: 'run-1',
      kind: 'captcha',
      detail: 'd',
      status: 'pending',
      busy: true,
      onTakeOver: () {},
      onDone: () async {},
    )));

    final takeOverButton = tester.widget<ElevatedButton>(
      find.byKey(const Key('takeover-take-over')),
    );
    final doneButton = tester.widget<TextButton>(
      find.byKey(const Key('takeover-done')),
    );
    expect(takeOverButton.onPressed, isNull);
    expect(doneButton.onPressed, isNull);
  });

  testWidgets('collapses to the status line and hides the actions once completed',
      (tester) async {
    await tester.pumpWidget(_wrap(TakeoverCard(
      runId: 'run-1',
      kind: 'captcha',
      detail: 'd',
      status: 'Completed',
      busy: false,
      onTakeOver: () {},
      onDone: () async {},
    )));

    expect(find.text('Completed'), findsOneWidget);
    expect(find.byKey(const Key('takeover-take-over')), findsNothing);
    expect(find.byKey(const Key('takeover-done')), findsNothing);
  });
}
