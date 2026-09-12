import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/api/live_agent_client.dart';
import 'package:oikonomos_mobile/screens/takeover_screen.dart';

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

/// TASK-228 — a fake [TakeoverWebSocketLike] that, unlike
/// [LiveAgentScreen]'s own test fake, DOES record what gets sent — the
/// entire point of this screen is that it can.
class _FakeTakeoverSocket extends Stream<dynamic>
    implements TakeoverWebSocketLike {
  final StreamController<dynamic> _controller = StreamController<dynamic>();
  final List<dynamic> sent = [];
  bool closed = false;

  void push(String chunk) => _controller.add(chunk);

  @override
  void add(dynamic data) => sent.add(data);

  @override
  StreamSubscription<dynamic> listen(
    void Function(dynamic event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return _controller.stream.listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }

  @override
  Future<void> close() async {
    closed = true;
    await _controller.close();
  }
}

void main() {
  testWidgets(
      'shows a genuine empty state, not a spinner or error, for a role with no active/recent sandbox',
      (tester) async {
    final fake = FakeHttpClient();
    final apiClient = await _loggedIn(fake);
    fake.queueJsonFor(
      'GET',
      '/roles/bot-1/live-agent/status',
      200,
      {'available': false},
    );

    await tester.pumpWidget(MaterialApp(
      home: TakeoverScreen(apiClient: apiClient, roleId: 'bot-1'),
    ));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('takeover-empty')), findsOneWidget);
    expect(find.byKey(const Key('takeover-terminal')), findsNothing);
  });

  testWidgets(
      'renders real live output and dials the takeover path, not the read-only viewer path',
      (tester) async {
    final fake = FakeHttpClient();
    final apiClient = await _loggedIn(fake);
    fake.queueJsonFor(
      'GET',
      '/roles/bot-1/live-agent/status',
      200,
      {'available': true, 'state': 'waiting_approval'},
    );

    final socket = _FakeTakeoverSocket();
    String? dialedUrl;

    await tester.pumpWidget(MaterialApp(
      home: TakeoverScreen(
        apiClient: apiClient,
        roleId: 'bot-1',
        client: LiveAgentClient(
          apiClient: apiClient,
          takeoverConnector: (url, {headers}) async {
            dialedUrl = url;
            return socket;
          },
        ),
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('takeover-terminal')), findsOneWidget);
    expect(dialedUrl, 'ws://localhost:3000/roles/bot-1/live-agent/takeover');

    socket.push('Password: ');
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('Password:'), findsOneWidget);
  });

  testWidgets(
      'genuinely sends what the human types — the entire reason this screen exists, unlike the read-only viewer',
      (tester) async {
    final fake = FakeHttpClient();
    final apiClient = await _loggedIn(fake);
    fake.queueJsonFor(
      'GET',
      '/roles/bot-1/live-agent/status',
      200,
      {'available': true, 'state': 'waiting_approval'},
    );

    final socket = _FakeTakeoverSocket();
    await tester.pumpWidget(MaterialApp(
      home: TakeoverScreen(
        apiClient: apiClient,
        roleId: 'bot-1',
        client: LiveAgentClient(
          apiClient: apiClient,
          takeoverConnector: (url, {headers}) async => socket,
        ),
      ),
    ));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('takeover-input')),
      'hunter2',
    );
    await tester.tap(find.byKey(const Key('takeover-send')));
    await tester.pump();

    expect(socket.sent, ['hunter2\n']);
    // The input clears after sending, same as a real chat composer.
    expect(
      tester.widget<TextField>(find.byKey(const Key('takeover-input'))).controller!.text,
      isEmpty,
    );
  });

  testWidgets('also sends on submit (pressing enter/done), not only the send button',
      (tester) async {
    final fake = FakeHttpClient();
    final apiClient = await _loggedIn(fake);
    fake.queueJsonFor(
      'GET',
      '/roles/bot-1/live-agent/status',
      200,
      {'available': true, 'state': 'waiting_approval'},
    );

    final socket = _FakeTakeoverSocket();
    await tester.pumpWidget(MaterialApp(
      home: TakeoverScreen(
        apiClient: apiClient,
        roleId: 'bot-1',
        client: LiveAgentClient(
          apiClient: apiClient,
          takeoverConnector: (url, {headers}) async => socket,
        ),
      ),
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('takeover-input')), '123456');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();

    expect(socket.sent, ['123456\n']);
  });

  testWidgets('closing the screen closes the takeover socket', (tester) async {
    final fake = FakeHttpClient();
    final apiClient = await _loggedIn(fake);
    fake.queueJsonFor(
      'GET',
      '/roles/bot-1/live-agent/status',
      200,
      {'available': true, 'state': 'waiting_approval'},
    );

    final socket = _FakeTakeoverSocket();
    await tester.pumpWidget(MaterialApp(
      home: TakeoverScreen(
        apiClient: apiClient,
        roleId: 'bot-1',
        client: LiveAgentClient(
          apiClient: apiClient,
          takeoverConnector: (url, {headers}) async => socket,
        ),
      ),
    ));
    await tester.pumpAndSettle();

    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    await tester.pumpAndSettle();
    expect(socket.closed, isTrue);
  });
}
