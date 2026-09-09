import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/login_screen.dart';
import 'package:oikonomos_mobile/screens/roster_screen.dart';

import '../support/fake_http_client.dart';

/// TASK-173 — fake [GoogleAuthPort] so these widget tests exercise the real
/// [LoginScreen]/[ApiClient] wiring without touching the real
/// `google_sign_in`/`firebase_auth` platform channels, which the widget
/// test harness has no access to. Mirrors how `FakeHttpClient` fakes the
/// HTTP boundary for [ApiClient].
class FakeGoogleAuthPort implements GoogleAuthPort {
  FakeGoogleAuthPort.succeeds(this._idToken) : _error = null;
  FakeGoogleAuthPort.fails(Object error)
      : _idToken = null,
        _error = error;

  final String? _idToken;
  final Object? _error;
  int signOutCallCount = 0;

  @override
  Future<String> signIn() async {
    if (_error != null) throw _error;
    return _idToken!;
  }

  @override
  AuthProfile? get currentProfile => null;

  @override
  Future<void> signOut() async {
    signOutCallCount++;
  }
}

void main() {
  testWidgets(
    'a cancelled sign-in shows no error and stays on the login screen',
    (tester) async {
      final apiClient = ApiClient(
        baseUrl: 'http://localhost:3000',
        httpClient: FakeHttpClient(),
      );
      final authPort =
          FakeGoogleAuthPort.fails(const SignInCancelledException());

      await tester.pumpWidget(
        MaterialApp(
          home: LoginScreen(apiClient: apiClient, authPort: authPort),
        ),
      );

      await tester.tap(find.byKey(const Key('sign-in-button')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('login-error')), findsNothing);
      expect(find.byType(RosterScreen), findsNothing);
    },
  );

  testWidgets(
    'a backend rejection (401) shows a real, visible error',
    (tester) async {
      final fake = FakeHttpClient();
      fake.queueJson(401, {'error': 'invalid or expired Firebase ID token'});
      final apiClient = ApiClient(
        baseUrl: 'http://localhost:3000',
        httpClient: fake,
      );
      final authPort = FakeGoogleAuthPort.succeeds('fake-firebase-id-token');

      await tester.pumpWidget(
        MaterialApp(
          home: LoginScreen(apiClient: apiClient, authPort: authPort),
        ),
      );

      await tester.tap(find.byKey(const Key('sign-in-button')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('login-error')), findsOneWidget);
      expect(find.byType(RosterScreen), findsNothing);
    },
  );

  testWidgets(
    'a network/other failure surfaces a real, visible error, never a silent failure',
    (tester) async {
      final apiClient = ApiClient(
        baseUrl: 'http://localhost:3000',
        httpClient: FakeHttpClient(),
      );
      final authPort = FakeGoogleAuthPort.fails(Exception('network down'));

      await tester.pumpWidget(
        MaterialApp(
          home: LoginScreen(apiClient: apiClient, authPort: authPort),
        ),
      );

      await tester.tap(find.byKey(const Key('sign-in-button')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('login-error')), findsOneWidget);
      expect(find.byType(RosterScreen), findsNothing);
    },
  );

  testWidgets(
    'a real Firebase ID token is POSTed to /auth/google and success navigates to the roster',
    (tester) async {
      final fake = FakeHttpClient();
      fake.queueJson(
        200,
        {'authenticated': true},
        headers: {'set-cookie': 'control_api_session=abc123; Path=/'},
      );
      // RosterScreen's initState immediately fetches GET /threads.
      fake.queueJson(200, <Object?>[]);
      final apiClient = ApiClient(
        baseUrl: 'http://localhost:3000',
        httpClient: fake,
      );
      final authPort = FakeGoogleAuthPort.succeeds('fake-firebase-id-token');

      await tester.pumpWidget(
        MaterialApp(
          home: LoginScreen(apiClient: apiClient, authPort: authPort),
        ),
      );

      await tester.tap(find.byKey(const Key('sign-in-button')));
      await tester.pumpAndSettle();

      expect(find.byType(RosterScreen), findsOneWidget);
      expect(find.byKey(const Key('login-error')), findsNothing);
      final sent = fake.requests
          .whereType<http.Request>()
          .firstWhere((r) => r.url.path == '/auth/google');
      expect(sent.method, 'POST');
      expect(jsonDecode(sent.body), {'idToken': 'fake-firebase-id-token'});
    },
  );

  test(
    'LoginScreen.signOut clears the client-side session and calls the auth port sign-out',
    () async {
      final fake = FakeHttpClient();
      fake.queueJson(
        200,
        {'authenticated': true},
        headers: {'set-cookie': 'control_api_session=abc123; Path=/'},
      );
      final apiClient = ApiClient(
        baseUrl: 'http://localhost:3000',
        httpClient: fake,
      );
      await apiClient.loginWithGoogle('fake-firebase-id-token');
      expect(apiClient.isAuthenticated, isTrue);

      final authPort = FakeGoogleAuthPort.succeeds('unused');
      await LoginScreen.signOut(apiClient, authPort);

      expect(apiClient.isAuthenticated, isFalse);
      expect(authPort.signOutCallCount, 1);
    },
  );
}
