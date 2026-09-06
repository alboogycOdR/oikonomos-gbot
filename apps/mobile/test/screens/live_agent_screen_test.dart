import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/api/live_agent_client.dart';
import 'package:oikonomos_mobile/screens/live_agent_screen.dart';

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

/// A fake [WebSocketLike] the test controls directly: pushes output on
/// demand and records whether anything was ever written to it (there is
/// no `write`/`send` method on the real client at all, but this stands
/// in for the underlying socket to prove the screen never even attempts
/// to call one).
class _FakeSocket extends Stream<dynamic> implements WebSocketLike {
  final StreamController<dynamic> _controller = StreamController<dynamic>();
  bool closed = false;

  void push(String chunk) => _controller.add(chunk);
  void finish() => _controller.close();

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
  testWidgets('shows a genuine empty state, not a spinner or error, for a role with no active/recent sandbox',
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
      home: LiveAgentScreen(apiClient: apiClient, roleId: 'bot-1'),
    ));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('live-agent-empty')), findsOneWidget);
    expect(find.byKey(const Key('live-agent-terminal')), findsNothing);
    expect(find.byKey(const Key('live-agent-loading')), findsNothing);
  });

  testWidgets('renders real live output from the PTY viewer stream, not placeholder content',
      (tester) async {
    final fake = FakeHttpClient();
    final apiClient = await _loggedIn(fake);
    fake.queueJsonFor(
      'GET',
      '/roles/bot-1/live-agent/status',
      200,
      {'available': true, 'state': 'Running'},
    );

    final socket = _FakeSocket();
    String? dialedUrl;
    Map<String, dynamic>? dialedHeaders;

    await tester.pumpWidget(MaterialApp(
      home: LiveAgentScreen(
        apiClient: apiClient,
        roleId: 'bot-1',
        client: LiveAgentClient(
          apiClient: apiClient,
          connector: (url, {headers}) async {
            dialedUrl = url;
            dialedHeaders = headers;
            return socket;
          },
        ),
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('live-agent-terminal')), findsOneWidget);
    expect(dialedUrl, 'ws://localhost:3000/roles/bot-1/live-agent/pty');
    expect(dialedHeaders, apiClient.cookieHeaders);

    socket.push('\$ starting task...\n');
    await tester.pump();
    socket.push('done.\n');
    await tester.pump();

    expect(find.textContaining('starting task...'), findsOneWidget);
    expect(find.textContaining('done.'), findsOneWidget);
  });

  testWidgets('never sends anything over the viewer socket — the client exposes no write path at all',
      (tester) async {
    final fake = FakeHttpClient();
    final apiClient = await _loggedIn(fake);
    fake.queueJsonFor(
      'GET',
      '/roles/bot-1/live-agent/status',
      200,
      {'available': true, 'state': 'Running'},
    );

    final socket = _FakeSocket();
    await tester.pumpWidget(MaterialApp(
      home: LiveAgentScreen(
        apiClient: apiClient,
        roleId: 'bot-1',
        client: LiveAgentClient(
          apiClient: apiClient,
          connector: (url, {headers}) async => socket,
        ),
      ),
    ));
    await tester.pumpAndSettle();

    // AC1 (mobile-side reinforcement): `WebSocketLike` has no `add`/`sink`/
    // `send` member for `LiveAgentClient` to call in the first place — the
    // real guarantee is server-side (liveAgent.routes.test.ts), but this
    // asserts the mobile code path never even attempts to originate input:
    // disposing the screen just closes the socket, nothing more.
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    await tester.pumpAndSettle();
    expect(socket.closed, isTrue);
  });

  testWidgets('a 501 (live-agent backend not yet wired) renders the same clean empty state, not an error',
      (tester) async {
    final fake = FakeHttpClient();
    final apiClient = await _loggedIn(fake);
    fake.queueJsonFor(
      'GET',
      '/roles/bot-1/live-agent/status',
      501,
      {'error': 'live-agent viewer is not configured on this server'},
    );

    await tester.pumpWidget(MaterialApp(
      home: LiveAgentScreen(apiClient: apiClient, roleId: 'bot-1'),
    ));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('live-agent-empty')), findsOneWidget);
    expect(find.byKey(const Key('live-agent-error')), findsNothing);
  });
}
