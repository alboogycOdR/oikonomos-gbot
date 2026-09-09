import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/login_screen.dart';
import 'package:oikonomos_mobile/screens/settings_screen.dart';

import '../support/fake_http_client.dart';

class _FakeGoogleAuthPort implements GoogleAuthPort {
  _FakeGoogleAuthPort({this.profile, this.signOutError});

  final AuthProfile? profile;
  final Object? signOutError;
  int signOutCallCount = 0;

  @override
  Future<String> signIn() async =>
      throw UnimplementedError('not exercised from SystemSettingsScreen');

  @override
  Future<void> signOut() async {
    signOutCallCount++;
    if (signOutError != null) throw signOutError!;
  }

  @override
  AuthProfile? get currentProfile => profile;
}

Future<ApiClient> _loggedIn(FakeHttpClient fake) async {
  fake.queueJson(
    200,
    {'authenticated': true},
    headers: {'set-cookie': 'control_api_session=abc123; Path=/'},
  );
  final client = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);
  await client.login('shared-token');
  return client;
}

void main() {
  testWidgets('profile header shows the signed-in name, email, and initial',
      (tester) async {
    final client = await _loggedIn(FakeHttpClient());
    final authPort = _FakeGoogleAuthPort(
      profile: const AuthProfile(
        displayName: 'Alister B',
        email: 'alister@example.com',
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: SystemSettingsScreen(apiClient: client, authPort: authPort),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Alister B'), findsOneWidget);
    expect(find.text('alister@example.com'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const Key('settings-avatar')),
        matching: find.text('A'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('profile header falls back to the email when there is no name',
      (tester) async {
    final client = await _loggedIn(FakeHttpClient());
    final authPort = _FakeGoogleAuthPort(
      profile: const AuthProfile(email: 'someone@example.com'),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: SystemSettingsScreen(apiClient: client, authPort: authPort),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('someone@example.com'), findsOneWidget);
    expect(find.byKey(const Key('settings-profile-email')), findsNothing);
    expect(
      find.descendant(
        of: find.byKey(const Key('settings-avatar')),
        matching: find.text('S'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('renders without a profile at all', (tester) async {
    final client = await _loggedIn(FakeHttpClient());

    await tester.pumpWidget(
      MaterialApp(
        home: SystemSettingsScreen(
          apiClient: client,
          authPort: _FakeGoogleAuthPort(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Signed in'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('shows the app version', (tester) async {
    final client = await _loggedIn(FakeHttpClient());

    await tester.pumpWidget(
      MaterialApp(
        home: SystemSettingsScreen(
          apiClient: client,
          authPort: _FakeGoogleAuthPort(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('settings-version')), findsOneWidget);
    expect(find.text('OIKONOMOS $kAppVersion'), findsOneWidget);
  });

  testWidgets('notifications toggle flips', (tester) async {
    final client = await _loggedIn(FakeHttpClient());

    await tester.pumpWidget(
      MaterialApp(
        home: SystemSettingsScreen(
          apiClient: client,
          authPort: _FakeGoogleAuthPort(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final toggle = find.byKey(const Key('settings-notifications'));
    expect(tester.widget<SwitchListTile>(toggle).value, isTrue);
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(toggle).value, isFalse);
  });

  testWidgets(
      'sign out clears the session, calls the auth port, and returns to '
      'LoginScreen with the stack cleared', (tester) async {
    final client = await _loggedIn(FakeHttpClient());
    final authPort = _FakeGoogleAuthPort();

    await tester.pumpWidget(
      MaterialApp(
        home: SystemSettingsScreen(apiClient: client, authPort: authPort),
      ),
    );
    await tester.pumpAndSettle();
    expect(client.isAuthenticated, isTrue);

    await tester.tap(find.byKey(const Key('sign-out-button')));
    await tester.pumpAndSettle();

    expect(authPort.signOutCallCount, 1);
    expect(client.isAuthenticated, isFalse);
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.byType(SystemSettingsScreen), findsNothing);
    expect(
      Navigator.of(tester.element(find.byType(LoginScreen))).canPop(),
      isFalse,
    );
  });

  testWidgets('a failed sign out stays on the screen and reports it',
      (tester) async {
    final client = await _loggedIn(FakeHttpClient());
    final authPort =
        _FakeGoogleAuthPort(signOutError: StateError('platform down'));

    await tester.pumpWidget(
      MaterialApp(
        home: SystemSettingsScreen(apiClient: client, authPort: authPort),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('sign-out-button')));
    await tester.pumpAndSettle();

    expect(authPort.signOutCallCount, 1);
    expect(find.byType(SystemSettingsScreen), findsOneWidget);
    expect(find.text('Could not sign out. Try again.'), findsOneWidget);
    expect(find.byType(LoginScreen), findsNothing);
  });
}
