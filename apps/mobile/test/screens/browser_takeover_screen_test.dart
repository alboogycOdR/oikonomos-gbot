import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/api/browser_takeover_client.dart';
import 'package:oikonomos_mobile/screens/browser_takeover_screen.dart';

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

/// A tiny 1x1 PNG, real decodable image bytes — [Image.memory] needs a
/// genuinely valid image or it throws, not just any byte sequence.
final List<int> _fixturePngBytes = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
);

class _FakeCdpSocket extends Stream<dynamic>
    implements BrowserTakeoverWebSocketLike {
  final List<Map<String, dynamic>> sent = [];
  bool closed = false;
  void Function(dynamic event)? _onData;

  void pushMessage(Map<String, dynamic> message) {
    _onData?.call(jsonEncode(message));
  }

  @override
  void add(dynamic data) {
    sent.add(jsonDecode(data as String) as Map<String, dynamic>);
  }

  @override
  StreamSubscription<dynamic> listen(
    void Function(dynamic event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    _onData = onData;
    return const Stream<dynamic>.empty().listen(null);
  }

  @override
  Future<void> close() async {
    closed = true;
  }
}

void main() {
  testWidgets(
    'renders the loading state, then a real decoded screencast frame once one arrives',
    (tester) async {
      final fake = FakeHttpClient();
      final apiClient = await _loggedIn(fake);
      final socket = _FakeCdpSocket();

      await tester.pumpWidget(MaterialApp(
        home: BrowserTakeoverScreen(
          apiClient: apiClient,
          runId: 'run-1',
          client: BrowserTakeoverClient(
            apiClient: apiClient,
            connector: (url, {headers}) async {
              expect(url, 'ws://localhost:3000/runs/run-1/browser-takeover');
              return socket;
            },
          ),
        ),
      ));

      expect(find.byKey(const Key('browser-takeover-loading')), findsOneWidget);

      // Drive the flatten-attach sequence for real, then a live frame.
      await tester.pump();
      socket.pushMessage({
        'id': 1,
        'result': {
          'targetInfos': [
            {'targetId': 'page-1', 'type': 'page'},
          ],
        },
      });
      await tester.pump();
      socket.pushMessage({
        'id': 2,
        'result': {'sessionId': 'session-1'},
      });
      await tester.pump();
      socket.pushMessage({
        'method': 'Page.screencastFrame',
        'params': {
          'data': base64Encode(_fixturePngBytes),
          'sessionId': 'frame-1',
        },
      });
      await tester.pump();

      expect(find.byKey(const Key('browser-takeover-loading')), findsNothing);
      expect(find.byKey(const Key('browser-takeover-frame')), findsOneWidget);
      // The frame must be acknowledged.
      expect(
        socket.sent.any((m) => m['method'] == 'Page.screencastFrameAck'),
        isTrue,
      );
    },
  );

  testWidgets(
    'a tap on the live surface sends a real CDP click at that position',
    (tester) async {
      final fake = FakeHttpClient();
      final apiClient = await _loggedIn(fake);
      final socket = _FakeCdpSocket();

      await tester.pumpWidget(MaterialApp(
        home: BrowserTakeoverScreen(
          apiClient: apiClient,
          runId: 'run-1',
          client: BrowserTakeoverClient(
            apiClient: apiClient,
            connector: (url, {headers}) async => socket,
          ),
        ),
      ));
      await tester.pump();
      socket.pushMessage({
        'id': 1,
        'result': {
          'targetInfos': [
            {'targetId': 'page-1', 'type': 'page'},
          ],
        },
      });
      await tester.pump();
      socket.pushMessage({
        'id': 2,
        'result': {'sessionId': 'session-1'},
      });
      await tester.pump();
      socket.pushMessage({
        'method': 'Page.screencastFrame',
        'params': {
          'data': base64Encode(_fixturePngBytes),
          'sessionId': 'frame-1',
        },
      });
      await tester.pump();

      final before = socket.sent.length;
      await tester.tap(find.byKey(const Key('browser-takeover-surface')));
      await tester.pump();

      final mouseEvents = socket.sent
          .skip(before)
          .where((m) => m['method'] == 'Input.dispatchMouseEvent')
          .toList();
      expect(mouseEvents, hasLength(2));
      expect(mouseEvents[0]['params']['type'], 'mousePressed');
      expect(mouseEvents[1]['params']['type'], 'mouseReleased');
    },
  );

  testWidgets(
    'typing text and pressing send forwards it as real CDP key events',
    (tester) async {
      final fake = FakeHttpClient();
      final apiClient = await _loggedIn(fake);
      final socket = _FakeCdpSocket();

      await tester.pumpWidget(MaterialApp(
        home: BrowserTakeoverScreen(
          apiClient: apiClient,
          runId: 'run-1',
          client: BrowserTakeoverClient(
            apiClient: apiClient,
            connector: (url, {headers}) async => socket,
          ),
        ),
      ));
      await tester.pump();
      socket.pushMessage({
        'id': 1,
        'result': {
          'targetInfos': [
            {'targetId': 'page-1', 'type': 'page'},
          ],
        },
      });
      await tester.pump();
      socket.pushMessage({
        'id': 2,
        'result': {'sessionId': 'session-1'},
      });
      await tester.pump();
      socket.pushMessage({
        'method': 'Page.screencastFrame',
        'params': {
          'data': base64Encode(_fixturePngBytes),
          'sessionId': 'frame-1',
        },
      });
      await tester.pump();

      await tester.enterText(
        find.byKey(const Key('browser-takeover-input')),
        '1234',
      );
      final before = socket.sent.length;
      await tester.tap(find.byKey(const Key('browser-takeover-send')));
      await tester.pump();

      final keyEvents = socket.sent
          .skip(before)
          .where((m) => m['method'] == 'Input.dispatchKeyEvent')
          .toList();
      expect(keyEvents, hasLength(4));
      expect(keyEvents.map((m) => m['params']['text']), ['1', '2', '3', '4']);
      // The field clears after sending.
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('browser-takeover-input')))
            .controller
            ?.text,
        '',
      );
    },
  );

  testWidgets('surfaces a transport error as a real error state, not a hang',
      (tester) async {
    final fake = FakeHttpClient();
    final apiClient = await _loggedIn(fake);

    await tester.pumpWidget(MaterialApp(
      home: BrowserTakeoverScreen(
        apiClient: apiClient,
        runId: 'run-1',
        client: BrowserTakeoverClient(
          apiClient: apiClient,
          connector: (url, {headers}) async =>
              throw Exception('connection refused'),
        ),
      ),
    ));
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('browser-takeover-error')), findsOneWidget);
  });
}
