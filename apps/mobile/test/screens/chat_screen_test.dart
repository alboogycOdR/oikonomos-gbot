import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
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

Map<String, dynamic> _messageJson(
  String id, {
  String role = 'bot',
  String body = 'hello',
}) {
  return {
    'id': id,
    'threadId': 'thread-1',
    'role': role,
    'body': body,
    'runId': null,
    'createdAt': '2026-09-04T00:00:0${id}Z',
  };
}

Map<String, dynamic> _approvalMessage(String id) => {
      ..._messageJson(id, body: 'I need your decision.'),
      'approval': {
        'nonce': 'raw-secret-nonce',
        'action_render': 'Run rm -rf /tmp/demo',
        'status': 'pending',
        'capability_id': 'shell.execute',
        'max_tier': 'T3',
      },
    };

void main() {
  testWidgets('loads history and shows it with no live event yet', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, [_messageJson('1', role: 'user', body: 'hi there')]);
    fake.queueHangingStream(200);

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(apiClient: client, bot: _bot),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('hi there'), findsOneWidget);
  });

  testWidgets('shows real handoff chips and opens the persisted handoff body', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]); // transcript
    fake.queueJsonFor('GET', '/roles/role-1/messages', 200, [
      {
        'messageId': 'handoff-1',
        'fromRoleId': 'role-1',
        'toRoleId': 'role-2',
        'body': 'Please take over the customer follow-up.',
        'createdAt': '2026-09-05T12:00:00Z',
      },
    ]);
    fake.queueJsonFor('GET', '/roles', 200, [
      {
        'id': 'role-2',
        'name': 'Trevor',
        'description': 'Specialist',
        'avatarSeed': 'seed-2'
      },
    ]);
    fake.queueHangingStream(200);

    await tester.pumpWidget(MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('handoff-chip-handoff-1')), findsOneWidget);
    expect(find.text('1 message with Trevor'), findsOneWidget);
    await tester.tap(find.byKey(const Key('handoff-chip-handoff-1')));
    await tester.pumpAndSettle();
    expect(find.text('Please take over the customer follow-up.'), findsOneWidget);
  });

  testWidgets('a streamed event appears without a refresh', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    final streamController = fake.queueControlledStream(200);

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(apiClient: client, bot: _bot),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('chat-empty')), findsOneWidget);

    final frame =
        'id: msg-1\ndata: ${jsonEncode(_messageJson('1', body: 'live reply'))}\n\n';
    streamController.add(utf8.encode(frame));
    await tester.pumpAndSettle();

    expect(find.text('live reply'), findsOneWidget);

    // Close the controller *before* disposing the widget: the stream still
    // has an active listener at this point, so `close()`'s returned Future
    // completes once the `onDone` event is delivered (as it would for a
    // real dropped connection). Closing after disposal — once
    // `ChatScreen.dispose()` has already cancelled the subscription — would
    // leave the single-subscription controller with no listener to ever
    // deliver the done event to, and `close()` would never complete.
    await streamController.close();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('leaving the screen closes the SSE subscription', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    final streamController = fake.queueControlledStream(200);

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
    // Pre-condition the teardown assertion below actually depends on: the
    // fake's controller has a live listener while the screen is subscribed.
    expect(streamController.hasListener, isTrue);

    Navigator.of(tester.element(find.byType(ChatScreen))).pop();
    await tester.pumpAndSettle();

    expect(find.byType(ChatScreen), findsNothing);
    // This is the assertion that actually flips on the bug: it only passes
    // if ChatScreen.dispose() genuinely cancelled/closed the SSE
    // subscription. If dispose() were a no-op, the controller would still
    // have its listener attached and this would fail.
    expect(streamController.hasListener, isFalse);

    // Do NOT await close() here: with no listener left (dispose already
    // cancelled it), a single-subscription controller's close() has no
    // one to deliver the done event to and its Future never completes —
    // the exact hang this test's sibling above works around by closing
    // *before* disposal. Fire-and-forget is fine; nothing here depends on
    // the controller reaching a closed state.
    unawaited(streamController.close());
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
      MaterialApp(
        home: ChatScreen(apiClient: client, bot: _bot),
      ),
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

  testWidgets(
    'renders an approval card and approves through the real endpoint shape',
    (tester) async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      fake.queueJson(200, [_approvalMessage('approval-1')]);
      fake.queueHangingStream(200);
      fake.queueJson(200, {'decided': true, 'approval': {}});

      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(apiClient: client, bot: _bot),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('approval-card-approval-1')), findsOneWidget);
      expect(find.text('Capability: shell.execute'), findsOneWidget);
      expect(find.text('Run rm -rf /tmp/demo'), findsOneWidget);
      expect(find.text('raw-secret-nonce'), findsNothing);

      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();

      final request = fake.requests.last;
      expect(request.method, 'POST');
      expect(request.url.path, '/approvals/raw-secret-nonce/decide');
      expect(request, isA<http.Request>());
      expect(jsonDecode((request as http.Request).body), {
        'decision': 'granted',
        'decidedBy': 'mobile:operator',
      });
      expect(find.text('Status: approved'), findsOneWidget);
    },
  );

  testWidgets('reflects a duplicate approval decision without crashing', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, [_approvalMessage('approval-2')]);
    fake.queueHangingStream(200);
    fake.queueJson(409, {'decided': false});

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(apiClient: client, bot: _bot),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Deny'));
    await tester.pumpAndSettle();

    final request = fake.requests.last;
    expect(request.method, 'POST');
    expect(request.url.path, '/approvals/raw-secret-nonce/decide');
    expect(request, isA<http.Request>());
    expect(jsonDecode((request as http.Request).body)['decision'], 'rejected');
    expect(
      find.text('Status: Already decided or no longer valid.'),
      findsOneWidget,
    );
    expect(find.text('Approve'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('loads read-only routines when the routines tab opens', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);
    fake.queueJson(200, [
      {
        'routineId': 'routine-1',
        'name': 'Daily briefing',
        'schedule': '0 8 * * *',
        'lastFireAt': '2026-09-04T08:00:00Z',
        'nextFireAt': '2026-09-05T08:00:00Z',
      },
    ]);

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(apiClient: client, bot: _bot),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Routines'));
    await tester.pumpAndSettle();

    expect(find.text('Daily briefing'), findsOneWidget);
    expect(find.textContaining('Schedule: 0 8 * * *'), findsOneWidget);
    expect(fake.requests.last.url.path, '/roles/role-1/routines');
  });

  testWidgets(
    'creating a routine refreshes the routines tab without leaving the screen',
    (tester) async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      fake.queueJson(200, <Object?>[]);
      fake.queueHangingStream(200);
      fake.queueJson(200, <Object?>[]); // initial (empty) routines load

      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(apiClient: client, bot: _bot),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Routines'));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('routines-empty')), findsOneWidget);
      expect(find.byKey(const Key('create-routine-fab')), findsOneWidget);

      await tester.tap(find.byKey(const Key('create-routine-fab')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('routine-name-field')), findsOneWidget);

      await tester.enterText(
        find.byKey(const Key('routine-name-field')),
        'Morning digest',
      );
      await tester.enterText(
        find.byKey(const Key('routine-schedule-field')),
        '0 8 * * *',
      );

      fake.queueJson(201, {
        'routineId': 'routine-new',
        'name': 'Morning digest',
        'schedule': '0 8 * * *',
        'lastFireAt': null,
        'nextFireAt': '2026-09-06T08:00:00Z',
      });
      fake.queueJson(200, [
        {
          'routineId': 'routine-new',
          'name': 'Morning digest',
          'schedule': '0 8 * * *',
          'lastFireAt': null,
          'nextFireAt': '2026-09-06T08:00:00Z',
        },
      ]);

      await tester.tap(find.byKey(const Key('create-routine-submit')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('routine-name-field')), findsNothing);
      expect(find.text('Morning digest'), findsOneWidget);
    },
  );

  testWidgets('a routine opens detail with real run status and timestamp', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);
    fake.queueJson(200, [
      {
        'routineId': 'routine-1',
        'name': 'Daily briefing',
        'schedule': '0 8 * * *',
        'lastFireAt': '2026-09-04T08:00:00Z',
        'nextFireAt': '2026-09-05T08:00:00Z',
      },
    ]);

    await tester.pumpWidget(MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Routines'));
    await tester.pumpAndSettle();

    fake.queueJson(200, {
      'tasks': [
        {'taskId': 'task-1'},
      ],
      'nextCursor': null,
    });
    fake.queueJson(200, {
      'runs': [
        {
          'runId': 'run-1',
          'taskId': 'task-1',
          'status': 'failed',
          'startedAt': '2026-09-05T08:23:00Z',
        },
      ],
      'nextCursor': null,
    });
    await tester.tap(find.byKey(const Key('routine-routine-1')));
    await tester.pumpAndSettle();

    expect(find.text('Run history'), findsOneWidget);
    expect(find.text('2026-09-05T08:23:00Z'), findsOneWidget);
    expect(find.text('Status: failed'), findsOneWidget);
    final taskRequest = fake.requests.firstWhere(
      (request) => request.url.path == '/tasks',
    );
    final runRequest = fake.requests.firstWhere(
      (request) => request.url.path == '/runs',
    );
    expect(taskRequest.url.queryParameters['routineId'], 'routine-1');
    expect(runRequest.url.queryParameters['taskId'], 'task-1');
  });

  testWidgets('routine detail shows an empty history state', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);
    fake.queueJson(200, [
      {
        'routineId': 'routine-empty',
        'name': 'New routine',
        'schedule': '0 8 * * *',
        'lastFireAt': null,
        'nextFireAt': null,
      },
    ]);

    await tester.pumpWidget(MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Routines'));
    await tester.pumpAndSettle();
    fake.queueJson(200, {'tasks': <Object?>[], 'nextCursor': null});
    await tester.tap(find.byKey(const Key('routine-routine-empty')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('routine-history-empty')), findsOneWidget);
  });

  testWidgets('shows auto-review settings without a usage figure', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);
    fake.queueJson(200, <Object?>[]); // GET /roles for the title field fetch

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(apiClient: client, bot: _bot),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('bot-settings-button')));
    await tester.pumpAndSettle();

    expect(find.text('Auto-review'), findsOneWidget);
    expect(
      find.text('Require approval for risky shell, MCP, and computer actions.'),
      findsOneWidget,
    );
    expect(find.textContaining('Usage'), findsNothing);
  });

  testWidgets('composer placeholder is personalized to the bot name', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(apiClient: client, bot: _bot),
      ),
    );
    await tester.pumpAndSettle();

    final field = tester.widget<TextField>(
      find.byKey(const Key('compose-field')),
    );
    expect(field.decoration?.hintText, 'Ask Concierge');
  });

  testWidgets('a bot message with markdown renders formatted, not raw', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, [
      _messageJson(
        '1',
        role: 'bot',
        body: '**bold claim**\n\n- item one\n- item two',
      ),
    ]);
    fake.queueHangingStream(200);

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(apiClient: client, bot: _bot),
      ),
    );
    await tester.pumpAndSettle();

    // Raw markdown syntax must not appear anywhere in a rendered Text node.
    expect(find.textContaining('**bold claim**'), findsNothing);
    expect(find.textContaining('- item one'), findsNothing);
    // The bulleted list items and the bold run are rendered as separate
    // structured content, not a single plain-text blob.
    expect(find.textContaining('item one'), findsOneWidget);
    expect(find.textContaining('item two'), findsOneWidget);
    expect(find.textContaining('bold claim'), findsOneWidget);
    expect(
      find.byKey(const Key('message-body-1')),
      findsOneWidget,
    );
  });

  testWidgets('a system message renders as a muted line, not a chat bubble', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, [
      _messageJson('1', role: 'system', body: 'Renamed to Assistant'),
    ]);
    fake.queueHangingStream(200);

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(apiClient: client, bot: _bot),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Renamed to Assistant'), findsOneWidget);
    expect(find.byIcon(Icons.info_outline), findsOneWidget);
    // No chat-bubble Container is built for a system event.
    expect(find.byKey(const Key('message-body-1')), findsNothing);
  });

  testWidgets('settings screen shows the title field, read-only', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);
    fake.queueJson(200, [
      {
        'id': 'role-1',
        'name': 'Concierge',
        'description': 'Front desk',
        'avatarSeed': 'seed-1',
        'title': 'Front Desk Lead',
      },
    ]);

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(apiClient: client, bot: _bot),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('bot-settings-button')));
    await tester.pumpAndSettle();

    expect(find.text('Title (optional)'), findsOneWidget);
    final field = tester.widget<TextField>(find.byKey(const Key('title-field')));
    expect(field.readOnly, isTrue);
    expect(field.controller?.text, 'Front Desk Lead');
    expect(fake.requests.last.url.path, '/roles');
  });
}
