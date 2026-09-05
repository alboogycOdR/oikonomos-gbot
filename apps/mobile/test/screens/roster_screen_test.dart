import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/push/push_message.dart';
import 'package:oikonomos_mobile/screens/chat_screen.dart';
import 'package:oikonomos_mobile/screens/create_bot_screen.dart';
import 'package:oikonomos_mobile/screens/login_screen.dart';
import 'package:oikonomos_mobile/screens/roster_screen.dart';

import '../support/fake_http_client.dart';
import '../support/fake_push_port.dart';

/// TASK-174 — fake [GoogleAuthPort] local to this test file (the real
/// `FakeGoogleAuthPort` in `login_screen_test.dart` lives under TASK-173's
/// `Owned_Paths`, not this task's) so the sign-out wiring can be exercised
/// without touching the real `google_sign_in`/`firebase_auth` platform
/// channels the widget test harness has no access to.
class _FakeGoogleAuthPort implements GoogleAuthPort {
  int signOutCallCount = 0;

  @override
  Future<String> signIn() async =>
      throw UnimplementedError('not exercised from RosterScreen');

  @override
  Future<void> signOut() async {
    signOutCallCount++;
  }
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
  testWidgets('renders real bots with avatar/name/preview/timestamp', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, [
      {
        'id': 'thread-1',
        'roleId': 'role-1',
        'botName': 'Concierge',
        'botDescription': 'Front desk',
        'avatarSeed': 'seed-1',
        'title': null,
        'lastMessagePreview': 'Hello there',
        'updatedAt': DateTime.now().toIso8601String(),
      },
      // A group thread must never appear in the roster (out of scope).
      {
        'id': 'thread-2',
        'memberRoleIds': ['role-1', 'role-2'],
        'memberNames': ['Concierge', 'Analyst'],
        'title': 'Group chat',
        'lastMessagePreview': 'hello all',
        'updatedAt': DateTime.now().toIso8601String(),
      },
    ]);

    await tester.pumpWidget(
      MaterialApp(home: RosterScreen(apiClient: client)),
    );
    await tester.pumpAndSettle();

    expect(find.text('Concierge'), findsOneWidget);
    expect(find.text('Hello there'), findsOneWidget);
    expect(find.byKey(const Key('bot-tile-thread-1')), findsOneWidget);
    expect(find.byKey(const Key('bot-tile-thread-2')), findsNothing);
  });

  testWidgets('tapping a bot navigates to its chat screen', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, [
      {
        'id': 'thread-1',
        'roleId': 'role-1',
        'botName': 'Concierge',
        'botDescription': 'Front desk',
        'avatarSeed': 'seed-1',
        'title': null,
        'lastMessagePreview': 'Hello there',
        'updatedAt': DateTime.now().toIso8601String(),
      },
    ]);
    // ChatScreen's initState fetches GET /threads/:id/messages then opens
    // the SSE stream (held open — see queueHangingStream's doc comment).
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);

    await tester.pumpWidget(
      MaterialApp(home: RosterScreen(apiClient: client)),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('bot-tile-thread-1')));
    await tester.pumpAndSettle();

    expect(find.byType(ChatScreen), findsOneWidget);

    // Pop back out so ChatScreen's dispose() cancels the pending SSE
    // reconnect timer before this test completes — otherwise the test
    // framework reports it as a leaked timer.
    Navigator.of(tester.element(find.byType(ChatScreen))).pop();
    await tester.pumpAndSettle();
  });

  testWidgets('empty roster shows an empty-state message', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);

    await tester.pumpWidget(
      MaterialApp(home: RosterScreen(apiClient: client)),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('roster-empty')), findsOneWidget);
  });

  testWidgets('tapping "New bot" opens the create-bot screen', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);

    await tester.pumpWidget(
      MaterialApp(home: RosterScreen(apiClient: client)),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('new-bot-button')));
    await tester.pumpAndSettle();

    expect(find.byType(CreateBotScreen), findsOneWidget);
  });

  testWidgets('creating a bot and returning reloads the roster with it', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    // Initial roster load: empty.
    fake.queueJson(200, <Object?>[]);

    await tester.pumpWidget(
      MaterialApp(home: RosterScreen(apiClient: client)),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('roster-empty')), findsOneWidget);

    await tester.tap(find.byKey(const Key('new-bot-button')));
    await tester.pumpAndSettle();
    expect(find.byType(CreateBotScreen), findsOneWidget);

    // CreateBotScreen.submit(): POST /roles, PATCH /roles/:id (charter),
    // then POST /threads.
    fake.queueJson(200, {
      'id': 'role-new',
      'name': 'Helper',
      'description': '',
      'avatarSeed': 'role-new',
    });
    fake.queueJson(200, {
      'id': 'role-new',
      'name': 'Helper',
      'description': '',
      'avatarSeed': 'role-new',
      'instructions': '# Job (and what I refuse)',
    });
    fake.queueJson(200, {
      'id': 'thread-new',
      'roleId': 'role-new',
      'botName': 'Helper',
      'botDescription': '',
      'avatarSeed': 'role-new',
      'title': null,
      'lastMessagePreview': null,
      'updatedAt': DateTime.now().toIso8601String(),
    });

    // RosterScreen._openCreateBot's `if (created == true) await _load()`
    // reload path fires within the same pump as the submit/pop below (the
    // pop's Navigator future resolves and _load() runs before
    // pumpAndSettle returns), so its response must be queued *before* the
    // tap — a second GET /threads returning the new bot.
    fake.queueJson(200, [
      {
        'id': 'thread-new',
        'roleId': 'role-new',
        'botName': 'Helper',
        'botDescription': '',
        'avatarSeed': 'role-new',
        'title': null,
        'lastMessagePreview': '',
        'updatedAt': DateTime.now().toIso8601String(),
      },
    ]);

    await tester.enterText(find.byKey(const Key('bot-name-field')), 'Helper');
    await tester.tap(find.byKey(const Key('create-bot-submit')));
    await tester.pumpAndSettle();

    expect(find.byType(CreateBotScreen), findsNothing);
    expect(find.byKey(const Key('bot-tile-thread-new')), findsOneWidget);
    expect(find.text('Helper'), findsOneWidget);
  });

  group('TASK-149 push notifications', () {
    testWidgets(
      'with the default (dormant) push port, boot behaves exactly as before'
      ' — no /devices call is ever made',
      (tester) async {
        final fake = FakeHttpClient();
        final client = await _loggedIn(fake);
        fake.queueJson(200, <Object?>[]);

        await tester.pumpWidget(
          MaterialApp(home: RosterScreen(apiClient: client)),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(const Key('roster-empty')), findsOneWidget);
        // Only login + the roster's own GET /threads were ever requested.
        expect(fake.requests, hasLength(2));
      },
    );

    testWidgets(
      'a foreground approval-pending message surfaces a snackbar',
      (tester) async {
        final fake = FakeHttpClient();
        final client = await _loggedIn(fake);
        fake.queueJson(200, <Object?>[]);
        final port = FakePushPort(initialToken: null);

        await tester.pumpWidget(
          MaterialApp(
            home: RosterScreen(apiClient: client, pushPort: port),
          ),
        );
        await tester.pumpAndSettle();

        port.emitMessage(
          const PushMessage(
            type: PushMessageType.approvalPending,
            runId: 'run-1',
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 750));

        expect(
          find.byKey(const Key('push-notification-snackbar')),
          findsOneWidget,
        );
        expect(
          find.text('A new approval is waiting for you.'),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'a foreground run-completed message surfaces a snackbar',
      (tester) async {
        final fake = FakeHttpClient();
        final client = await _loggedIn(fake);
        fake.queueJson(200, <Object?>[]);
        final port = FakePushPort(initialToken: null);

        await tester.pumpWidget(
          MaterialApp(
            home: RosterScreen(apiClient: client, pushPort: port),
          ),
        );
        await tester.pumpAndSettle();

        port.emitMessage(
          const PushMessage(type: PushMessageType.runCompleted, runId: 'run-2'),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 750));

        expect(find.text('A run just completed.'), findsOneWidget);
      },
    );

    testWidgets(
      'a configured port registers the initial token via POST /devices',
      (tester) async {
        final fake = FakeHttpClient();
        final client = await _loggedIn(fake);
        fake.queueJson(200, <Object?>[]);
        fake.queueJson(201, {'registered': true});
        final port = FakePushPort(initialToken: 'token-abc');

        await tester.pumpWidget(
          MaterialApp(
            home: RosterScreen(apiClient: client, pushPort: port),
          ),
        );
        await tester.pumpAndSettle();

        final devicesRequest = fake.requests.firstWhere(
          (r) => r.url.path == '/devices',
        );
        expect(devicesRequest.method, 'POST');
      },
    );

    testWidgets('disposing the screen disposes the push port', (
      tester,
    ) async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      fake.queueJson(200, <Object?>[]);
      final port = FakePushPort(initialToken: null);

      await tester.pumpWidget(
        MaterialApp(home: RosterScreen(apiClient: client, pushPort: port)),
      );
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();

      expect(port.disposed, isTrue);
    });
  });

  group('TASK-174 sign-out', () {
    testWidgets(
      'tapping sign-out clears the session, signs out, and returns to '
      'LoginScreen with the navigation stack cleared',
      (tester) async {
        final fake = FakeHttpClient();
        final client = await _loggedIn(fake);
        fake.queueJson(200, <Object?>[]);
        final authPort = _FakeGoogleAuthPort();

        await tester.pumpWidget(
          MaterialApp(
            home: RosterScreen(apiClient: client, authPort: authPort),
          ),
        );
        await tester.pumpAndSettle();

        expect(client.isAuthenticated, isTrue);

        await tester.tap(find.byKey(const Key('sign-out-button')));
        await tester.pumpAndSettle();

        expect(authPort.signOutCallCount, 1);
        expect(client.isAuthenticated, isFalse);
        expect(find.byType(LoginScreen), findsOneWidget);
        expect(find.byType(RosterScreen), findsNothing);
        // Navigation stack was cleared (pushAndRemoveUntil), so there is
        // nothing to pop back to the roster from.
        expect(Navigator.of(tester.element(find.byType(LoginScreen))).canPop(),
            isFalse);
      },
    );
  });
}
