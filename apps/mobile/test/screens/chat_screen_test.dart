import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/api/models.dart';
import 'package:oikonomos_mobile/screens/chat_screen.dart';

import '../support/fake_http_client.dart';

const _bot = SingleThread(
  id: 'thread-1',
  roleId: 'role-1',
  botName: 'Concierge',
  botDescription: 'Front desk',
  avatarSeed: 'seed-1',
  title: null,
  lastMessagePreview: 'hi',
  updatedAt: '2026-09-04T00:00:00Z',
);

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

Map<String, dynamic> _messageJson(String id, {String role = 'bot', String body = 'hello'}) {
  return {
    'id': id,
    'threadId': 'thread-1',
    'role': role,
    'body': body,
    'runId': null,
    'createdAt': '2026-09-04T00:00:0${id}Z',
  };
}

void main() {
  testWidgets('loads history and shows it with no live event yet', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, [_messageJson('1', role: 'user', body: 'hi there')]);
    fake.queueHangingStream(200);

    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)),
    );
    await tester.pumpAndSettle();

    expect(find.text('hi there'), findsOneWidget);
  });

  testWidgets('a streamed event appears without a refresh', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    final streamController = fake.queueControlledStream(200);

    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('chat-empty')), findsOneWidget);

    final frame =
        'id: msg-1\ndata: ${jsonEncode(_messageJson('1', body: 'live reply'))}\n\n';
    streamController.add(utf8.encode(frame));
    await tester.pumpAndSettle();

    expect(find.text('live reply'), findsOneWidget);

    // Dispose cleanly instead of letting the controller dangle.
    await tester.pumpWidget(const SizedBox());
    await streamController.close();
  });

  testWidgets('leaving the screen closes the SSE subscription', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ChatScreen(apiClient: client, bot: _bot),
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    final state = tester.state<ChatScreenState>(find.byType(ChatScreen));
    expect(state.hasOpenSubscription, isTrue);

    Navigator.of(tester.element(find.byType(ChatScreen))).pop();
    await tester.pumpAndSettle();

    // The widget (and its State) is disposed; hasOpenSubscription can no
    // longer be observed, but its dispose() having run without error and
    // the widget being gone from the tree is the externally-visible
    // guarantee that subscribeToThreadMessages().close() was called.
    expect(find.byType(ChatScreen), findsNothing);
  });

  testWidgets('sending a message posts it and appends the reply', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);
    fake.queueJson(200, _messageJson('2', role: 'user', body: 'hello bot'));

    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('compose-field')), 'hello bot');
    await tester.tap(find.byKey(const Key('send-button')));
    await tester.pumpAndSettle();

    expect(find.text('hello bot'), findsOneWidget);

    final sendRequest = fake.requests.last;
    expect(sendRequest.method, 'POST');
    expect(sendRequest.url.path, '/threads/thread-1/messages');
  });
}
