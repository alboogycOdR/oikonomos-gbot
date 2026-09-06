import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/api/models.dart';
import 'package:oikonomos_mobile/attach/file_picker_port.dart';
import 'package:oikonomos_mobile/screens/chat_screen.dart';

import '../support/fake_file_picker.dart';
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
  // The context meter is an optional header enhancement. Give existing
  // transcript-focused tests a deterministic default without changing their
  // chronological request queues.
  fake.queueJsonFor('GET', '/threads/thread-1', 200, {
    'id': 'thread-1',
    'contextTokens': 12,
    'contextLimit': 100,
    'epoch': 0,
  });
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
  testWidgets(
      'context meter uses the real thread payload and fresh keeps earlier messages',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/threads/thread-1', 200, {
      'id': 'thread-1',
      'contextTokens': 80,
      'contextLimit': 100,
      'epoch': 2,
    });
    fake.queueJsonFor('GET', '/threads/thread-1/messages', 200,
        [_messageJson('1', body: 'Earlier turn')]);
    fake.queueJsonFor('POST', '/threads/thread-1/fresh', 200, {
      'id': 'thread-1',
      'contextTokens': 0,
      'contextLimit': 100,
      'epoch': 3,
    });
    fake.queueHangingStream(200);

    await tester.pumpWidget(
        MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('context-meter')), findsOneWidget);
    expect(find.text('Earlier turn'), findsOneWidget);

    await tester.tap(find.byKey(const Key('chat-overflow-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Start fresh'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Earlier turns stay visible'), findsOneWidget);
    await tester.tap(find.byKey(const Key('start-fresh-confirm')));
    await tester.pumpAndSettle();

    expect(
        fake.requests.any((request) =>
            request.method == 'POST' &&
            request.url.path == '/threads/thread-1/fresh'),
        isTrue);
    expect(find.text('Earlier turn'), findsOneWidget);
  });

  testWidgets('typing slash opens enabled-only picker and inserts its token',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/threads/thread-1/messages', 200, <Object?>[]);
    fake.queueJsonFor('GET', '/roles/role-1/messages', 200, <Object?>[]);
    fake.queueJsonFor('GET', '/roles/role-1/skills', 200, [
      {
        'skillId': 'skill-1',
        'name': 'summarize',
        'description': 'Condense text',
        'body': '# Steps',
        'approvals': <String>[],
        'status': 'active',
      },
    ]);
    fake.queueHangingStream(200);
    await tester.pumpWidget(
        MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('compose-field')), '/');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('skill-picker-skill-1')));
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<TextField>(find.byKey(const Key('compose-field')))
            .controller
            ?.text,
        '/summarize ');
  });

  testWidgets('skill toggle applies only the server-confirmed answer',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/threads/thread-1/messages', 200, <Object?>[]);
    fake.queueJsonFor('GET', '/roles/role-1/messages', 200, <Object?>[]);
    fake.queueJsonFor('GET', '/roles', 200, [
      {
        'id': 'role-1',
        'name': 'Concierge',
        'description': 'Front desk',
        'avatarSeed': 'seed-1'
      },
    ]);
    fake.queueJsonFor('GET', '/skills', 200, [
      {
        'skillId': 'skill-1',
        'name': 'summarize',
        'description': 'Condense text',
        'body': '# Steps',
        'approvals': <String>[],
        'status': 'active'
      },
    ]);
    fake.queueJsonFor('GET', '/roles/role-1/skills', 200, <Object?>[]);
    fake.queueJsonFor('PUT', '/roles/role-1/skills/skill-1', 200,
        {'roleId': 'role-1', 'skillId': 'skill-1', 'enabled': true});
    fake.queueHangingStream(200);
    await tester.pumpWidget(
        MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('bot-settings-button')));
    await tester.pumpAndSettle();
    final toggle = find.byKey(const Key('skill-enable-skill-1'));
    await tester.drag(find.byType(ListView).last, const Offset(0, -240));
    await tester.pumpAndSettle();
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<SwitchListTile>(
                find.byKey(const Key('skill-enable-skill-1')))
            .value,
        isTrue);
    final request = fake.requests.last as http.Request;
    expect(request.method, 'PUT');
    expect(request.url.path, '/roles/role-1/skills/skill-1');
  });

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

  testWidgets('shows real handoff chips and opens the persisted handoff body',
      (tester) async {
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

    await tester.pumpWidget(
        MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('handoff-chip-handoff-1')), findsOneWidget);
    expect(find.text('1 message with Trevor'), findsOneWidget);
    await tester.tap(find.byKey(const Key('handoff-chip-handoff-1')));
    await tester.pumpAndSettle();
    expect(
        find.text('Please take over the customer follow-up.'), findsOneWidget);
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

  testWidgets('attach button is present on the composer', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);

    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('attach-button')), findsOneWidget);
  });

  testWidgets(
    'picking a file uploads it with visible progress then a pending chip',
    (tester) async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      fake.queueJson(200, <Object?>[]);
      fake.queueHangingStream(200);
      fake.queueJson(
        201,
        {
          'id': 'att-1',
          'filename': 'notes.txt',
          'contentType': 'text/plain',
          'byteSize': 5,
          'sha256': 'aabbcc',
        },
        delay: const Duration(milliseconds: 50),
      );
      final picker = FakeFilePicker(
        picked: const PickedAttachment(
          filename: 'notes.txt',
          contentType: 'text/plain',
          bytes: [104, 101, 108, 108, 111],
        ),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(
            apiClient: client,
            bot: _bot,
            filePicker: picker,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('attach-button')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 10));
      expect(find.byKey(const Key('attach-progress')), findsOneWidget);
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('pending-attachment-att-1')), findsOneWidget);
      expect(find.text('notes.txt'), findsOneWidget);
      expect(picker.pickCount, 1);

      final upload = fake.requests.last;
      expect(upload.method, 'POST');
      expect(upload.url.path, '/threads/thread-1/attachments');
    },
  );

  testWidgets('cancelling the picker does not upload', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);
    final picker = FakeFilePicker();

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          apiClient: client,
          bot: _bot,
          filePicker: picker,
        ),
      ),
    );
    await tester.pumpAndSettle();

    final requestsBefore = fake.requests.length;
    await tester.tap(find.byKey(const Key('attach-button')));
    await tester.pumpAndSettle();

    expect(picker.pickCount, 1);
    expect(fake.requests.length, requestsBefore);
    expect(find.byKey(const Key('attach-progress')), findsNothing);
    expect(find.byKey(const Key('attach-error')), findsNothing);
  });

  testWidgets('upload error shows the server rejection message',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);
    fake.queueJson(400, {
      'error': 'file exceeds the 10485760-byte limit.',
    });
    final picker = FakeFilePicker(
      picked: const PickedAttachment(
        filename: 'huge.bin',
        contentType: 'application/pdf',
        bytes: [1, 2, 3],
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          apiClient: client,
          bot: _bot,
          filePicker: picker,
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('attach-button')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('attach-error')), findsOneWidget);
    expect(find.text('file exceeds the 10485760-byte limit.'), findsOneWidget);
  });

  testWidgets('send with a pending attachment posts attachmentIds',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);
    fake.queueJson(201, {
      'id': 'att-1',
      'filename': 'notes.txt',
      'contentType': 'text/plain',
      'byteSize': 5,
      'sha256': 'aabbcc',
    });
    fake.queueJson(201, {
      'id': 'msg-9',
      'threadId': 'thread-1',
      'role': 'user',
      'body': 'please read this',
      'runId': null,
      'createdAt': '2026-09-05T00:00:00Z',
      'attachments': [
        {
          'id': 'att-1',
          'filename': 'notes.txt',
          'contentType': 'text/plain',
          'byteSize': 5,
          'sha256': 'aabbcc',
        },
      ],
    });
    final picker = FakeFilePicker(
      picked: const PickedAttachment(
        filename: 'notes.txt',
        contentType: 'text/plain',
        bytes: [104, 101, 108, 108, 111],
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          apiClient: client,
          bot: _bot,
          filePicker: picker,
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('attach-button')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('compose-field')),
      'please read this',
    );
    await tester.tap(find.byKey(const Key('send-button')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('message-attachment-att-1')), findsOneWidget);
    final send = fake.requests.last as http.Request;
    expect(send.url.path, '/threads/thread-1/messages');
    expect(jsonDecode(send.body), {
      'body': 'please read this',
      'attachmentIds': ['att-1'],
    });
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
      fake.queueJsonFor('GET', '/roles/role-1/skills', 200, [
        {
          'skillId': 'skill-enabled',
          'name': 'summarize',
          'description': 'Condense text',
          'body': '# Steps',
          'approvals': <String>[],
          'status': 'active',
        },
      ]);
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
      expect(find.byKey(const Key('routine-skill-selector')), findsOneWidget);
      await tester.tap(find.byKey(const Key('routine-skill-selector')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('/summarize').last);
      await tester.pumpAndSettle();

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
      final createRequest = fake.requests.lastWhere(
        (request) =>
            request.method == 'POST' &&
            request.url.path == '/roles/role-1/routines',
      ) as http.Request;
      expect(jsonDecode(createRequest.body)['skillId'], 'skill-enabled');
    },
  );

  testWidgets('a routine opens detail with real run status and timestamp',
      (tester) async {
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
        MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)));
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

    await tester.pumpWidget(
        MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)));
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

  testWidgets('a context-compacted system message renders as a muted line', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, [
      _messageJson('1',
          role: 'system', body: 'Context compacted: earlier turns summarized'),
    ]);
    fake.queueHangingStream(200);

    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(apiClient: client, bot: _bot),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Context compacted: earlier turns summarized'),
        findsOneWidget);
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
        'instructions': null,
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
    final field =
        tester.widget<TextField>(find.byKey(const Key('title-field')));
    expect(field.readOnly, isTrue);
    expect(field.controller?.text, 'Front Desk Lead');
    expect(
      field.decoration?.helperText,
      'Read-only — no update endpoint exists for this yet.',
    );
    expect(
      fake.requests.any((request) => request.url.path == '/roles'),
      isTrue,
    );
  });

  testWidgets(
    'settings screen shows "No title set" only when title is genuinely null',
    (tester) async {
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
          'title': null,
          'instructions': null,
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

      final field =
          tester.widget<TextField>(find.byKey(const Key('title-field')));
      expect(field.controller?.text, isEmpty);
      expect(field.decoration?.hintText, 'No title set');
    },
  );

  testWidgets(
    'settings instructions field is pre-filled and PATCHes on save',
    (tester) async {
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
          'instructions': 'Be a calm concierge.',
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

      final field = tester.widget<TextField>(
        find.byKey(const Key('instructions-field')),
      );
      expect(field.controller?.text, 'Be a calm concierge.');
      expect(field.readOnly, isFalse);

      await tester.enterText(
        find.byKey(const Key('instructions-field')),
        'Answer as a front-desk lead.',
      );
      fake.queueJson(200, {
        'id': 'role-1',
        'name': 'Concierge',
        'description': 'Front desk',
        'avatarSeed': 'seed-1',
        'title': 'Front Desk Lead',
        'instructions': 'Answer as a front-desk lead.',
      });
      await tester.tap(find.byKey(const Key('instructions-save')));
      await tester.pumpAndSettle();

      final request = fake.requests.last as http.Request;
      expect(request.method, 'PATCH');
      expect(request.url.path, '/roles/role-1');
      expect(jsonDecode(request.body), {
        'instructions': 'Answer as a front-desk lead.',
      });
      expect(find.byKey(const Key('instructions-error')), findsNothing);
    },
  );

  testWidgets(
    'a failed instructions save surfaces a visible error',
    (tester) async {
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
          'instructions': null,
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

      await tester.enterText(
        find.byKey(const Key('instructions-field')),
        'persona',
      );
      fake.queueJson(400, {'error': 'role not found'});
      await tester.tap(find.byKey(const Key('instructions-save')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('instructions-error')), findsOneWidget);
      expect(find.text('role not found'), findsOneWidget);
      expect(find.byKey(const Key('instructions-field')), findsOneWidget);
    },
  );

  testWidgets(
    'clearing instructions and saving PATCHes an empty string',
    (tester) async {
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
          'instructions': 'Old persona',
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

      await tester.enterText(find.byKey(const Key('instructions-field')), '');
      fake.queueJson(200, {
        'id': 'role-1',
        'name': 'Concierge',
        'description': 'Front desk',
        'avatarSeed': 'seed-1',
        'title': 'Front Desk Lead',
        'instructions': '',
      });
      await tester.tap(find.byKey(const Key('instructions-save')));
      await tester.pumpAndSettle();

      final request = fake.requests.last as http.Request;
      expect(request.method, 'PATCH');
      expect(jsonDecode(request.body), {'instructions': ''});
    },
  );

  testWidgets(
    'composer renders as a pill with attach/send still present and working',
    (tester) async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      fake.queueJson(200, <Object?>[]);
      fake.queueHangingStream(200);
      fake.queueJson(200, _messageJson('2', role: 'user', body: 'hey'));

      await tester.pumpWidget(
        MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)),
      );
      await tester.pumpAndSettle();

      final pillFinder = find.byKey(const Key('composer-pill'));
      expect(pillFinder, findsOneWidget);
      final pill = tester.widget<Container>(pillFinder);
      final decoration = pill.decoration as BoxDecoration;
      expect(decoration.borderRadius, isNotNull);

      // Attach and send buttons still present inside the pill, and the send
      // flow still works exactly as before — only the wrapper changed.
      expect(
        find.descendant(
          of: pillFinder,
          matching: find.byKey(const Key('attach-button')),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: pillFinder,
          matching: find.byKey(const Key('send-button')),
        ),
        findsOneWidget,
      );

      await tester.enterText(find.byKey(const Key('compose-field')), 'hey');
      await tester.tap(find.byKey(const Key('send-button')));
      await tester.pumpAndSettle();

      expect(find.text('hey'), findsOneWidget);
    },
  );

  testWidgets('header renders with a frosted/translucent backdrop', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(200, <Object?>[]);
    fake.queueHangingStream(200);

    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('chat-header-frost')), findsOneWidget);
    final appBar = tester.widget<AppBar>(find.byType(AppBar));
    expect(appBar.backgroundColor, isNotNull);
    expect(appBar.backgroundColor!.a, lessThan(1.0));
  });

  testWidgets(
    'shows a date divider between message clusters that cross a day boundary',
    (tester) async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      fake.queueJson(200, [
        {
          ..._messageJson('1', role: 'user', body: 'day one message'),
          'createdAt': '2026-09-03T10:00:00Z',
        },
        {
          ..._messageJson('2', role: 'bot', body: 'day two message'),
          'createdAt': '2026-09-04T09:00:00Z',
        },
      ]);
      fake.queueHangingStream(200);

      await tester.pumpWidget(
        MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)),
      );
      await tester.pumpAndSettle();

      // Both real messages present, and exactly one divider for the one real
      // day boundary crossed (before message 1 — the first cluster).
      expect(find.text('day one message'), findsOneWidget);
      expect(find.text('day two message'), findsOneWidget);
      expect(find.byKey(const Key('date-divider-1')), findsOneWidget);
      expect(find.byKey(const Key('date-divider-2')), findsOneWidget);
    },
  );

  testWidgets(
    'no extra date divider when messages fall on the same real day',
    (tester) async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      fake.queueJson(200, [
        {
          ..._messageJson('1', role: 'user', body: 'first'),
          'createdAt': '2026-09-04T09:00:00Z',
        },
        {
          ..._messageJson('2', role: 'bot', body: 'second'),
          'createdAt': '2026-09-04T09:05:00Z',
        },
      ]);
      fake.queueHangingStream(200);

      await tester.pumpWidget(
        MaterialApp(home: ChatScreen(apiClient: client, bot: _bot)),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('date-divider-1')), findsOneWidget);
      expect(find.byKey(const Key('date-divider-2')), findsNothing);
    },
  );
}
