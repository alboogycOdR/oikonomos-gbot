import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/chat_screen.dart';
import 'package:oikonomos_mobile/screens/create_bot_screen.dart';
import 'package:oikonomos_mobile/screens/roster_screen.dart';

import '../support/fake_http_client.dart';

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

    // CreateBotScreen.submit(): POST /roles then POST /threads.
    fake.queueJson(200, {
      'id': 'role-new',
      'name': 'Helper',
      'description': '',
      'avatarSeed': 'role-new',
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
}
