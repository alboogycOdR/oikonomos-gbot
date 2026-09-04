import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/login_screen.dart';
import 'package:oikonomos_mobile/screens/roster_screen.dart';

import '../support/fake_http_client.dart';

void main() {
  testWidgets('bad token shows an error and stays on the login screen', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    fake.queueJson(401, {'error': 'invalid token'});
    final apiClient = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);

    await tester.pumpWidget(
      MaterialApp(home: LoginScreen(apiClient: apiClient)),
    );

    await tester.enterText(find.byKey(const Key('token-field')), 'bad-token');
    await tester.pump();
    await tester.tap(find.byKey(const Key('sign-in-button')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('login-error')), findsOneWidget);
    expect(find.text('Invalid token.'), findsOneWidget);
    expect(find.byType(RosterScreen), findsNothing);
  });

  testWidgets('good token navigates to the roster screen', (tester) async {
    final fake = FakeHttpClient();
    fake.queueJson(
      200,
      {'authenticated': true},
      headers: {'set-cookie': 'control_api_session=abc123; Path=/'},
    );
    // RosterScreen's initState immediately fetches GET /threads.
    fake.queueJson(200, <Object?>[]);
    final apiClient = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);

    await tester.pumpWidget(
      MaterialApp(home: LoginScreen(apiClient: apiClient)),
    );

    await tester.enterText(
      find.byKey(const Key('token-field')),
      'good-token',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('sign-in-button')));
    await tester.pumpAndSettle();

    expect(find.byType(RosterScreen), findsOneWidget);
    expect(find.byKey(const Key('login-error')), findsNothing);
  });

  testWidgets('sign-in button is disabled while the token field is empty', (
    tester,
  ) async {
    final apiClient = ApiClient(
      baseUrl: 'http://localhost:3000',
      httpClient: FakeHttpClient(),
    );

    await tester.pumpWidget(
      MaterialApp(home: LoginScreen(apiClient: apiClient)),
    );

    final button = tester.widget<ElevatedButton>(
      find.byKey(const Key('sign-in-button')),
    );
    expect(button.onPressed, isNull);
  });
}
