import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/models.dart';
import 'package:oikonomos_mobile/widgets/secret_request_card.dart';

const _request = SecretRequestRef(
  requestId: 'req-1',
  label: 'Stripe API key',
  purpose: 'to issue a refund',
  status: 'pending',
);

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  testWidgets('renders the label and purpose, masks the input by default',
      (tester) async {
    await tester.pumpWidget(_wrap(SecretRequestCard(
      request: _request,
      status: 'pending',
      busy: false,
      onProvide: (_) async {},
      onDecline: () async {},
    )));

    expect(find.text('Asking for: Stripe API key'), findsOneWidget);
    expect(find.text('to issue a refund'), findsOneWidget);
    final field = tester.widget<TextField>(
      find.byKey(const Key('secret-request-input')),
    );
    expect(field.obscureText, isTrue);
    expect(field.autocorrect, isFalse);
    expect(field.enableInteractiveSelection, isFalse);
  });

  testWidgets('toggling visibility flips obscureText', (tester) async {
    await tester.pumpWidget(_wrap(SecretRequestCard(
      request: _request,
      status: 'pending',
      busy: false,
      onProvide: (_) async {},
      onDecline: () async {},
    )));

    await tester.tap(find.byKey(const Key('secret-request-toggle-obscure')));
    await tester.pump();
    final field = tester.widget<TextField>(
      find.byKey(const Key('secret-request-input')),
    );
    expect(field.obscureText, isFalse);
  });

  testWidgets('Provide sends the typed value and clears the field',
      (tester) async {
    String? provided;
    await tester.pumpWidget(_wrap(SecretRequestCard(
      request: _request,
      status: 'pending',
      busy: false,
      onProvide: (value) async {
        provided = value;
      },
      onDecline: () async {},
    )));

    await tester.enterText(
      find.byKey(const Key('secret-request-input')),
      'sk_live_secret_value',
    );
    await tester.tap(find.byKey(const Key('secret-request-provide')));
    await tester.pumpAndSettle();

    expect(provided, 'sk_live_secret_value');
    final field = tester.widget<TextField>(
      find.byKey(const Key('secret-request-input')),
    );
    expect(field.controller!.text, isEmpty);
  });

  testWidgets('Provide does nothing on a blank value', (tester) async {
    var calls = 0;
    await tester.pumpWidget(_wrap(SecretRequestCard(
      request: _request,
      status: 'pending',
      busy: false,
      onProvide: (_) async {
        calls++;
      },
      onDecline: () async {},
    )));

    await tester.enterText(
      find.byKey(const Key('secret-request-input')),
      '   ',
    );
    await tester.tap(find.byKey(const Key('secret-request-provide')));
    await tester.pumpAndSettle();

    expect(calls, 0);
  });

  testWidgets('Decline invokes the callback', (tester) async {
    var declined = false;
    await tester.pumpWidget(_wrap(SecretRequestCard(
      request: _request,
      status: 'pending',
      busy: false,
      onProvide: (_) async {},
      onDecline: () async {
        declined = true;
      },
    )));

    await tester.tap(find.byKey(const Key('secret-request-decline')));
    await tester.pumpAndSettle();

    expect(declined, isTrue);
  });

  testWidgets('busy disables both actions', (tester) async {
    await tester.pumpWidget(_wrap(SecretRequestCard(
      request: _request,
      status: 'pending',
      busy: true,
      onProvide: (_) async {},
      onDecline: () async {},
    )));

    final provideButton = tester.widget<ElevatedButton>(
      find.byKey(const Key('secret-request-provide')),
    );
    final declineButton = tester.widget<TextButton>(
      find.byKey(const Key('secret-request-decline')),
    );
    expect(provideButton.onPressed, isNull);
    expect(declineButton.onPressed, isNull);
  });

  testWidgets('collapses to the status line and hides the input once decided',
      (tester) async {
    await tester.pumpWidget(_wrap(SecretRequestCard(
      request: _request,
      status: 'Provided · secret://vault-ref-req-1',
      busy: false,
      onProvide: (_) async {},
      onDecline: () async {},
    )));

    expect(find.text('Provided · secret://vault-ref-req-1'), findsOneWidget);
    expect(find.byKey(const Key('secret-request-input')), findsNothing);
    expect(find.byKey(const Key('secret-request-provide')), findsNothing);
    expect(find.byKey(const Key('secret-request-decline')), findsNothing);
  });
}
