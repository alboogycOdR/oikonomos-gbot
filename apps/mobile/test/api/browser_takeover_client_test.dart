import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/api/browser_takeover_client.dart';

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

/// A fake [BrowserTakeoverWebSocketLike] the test fully controls: records
/// every outgoing command (as decoded JSON, for easy assertions) and lets
/// the test push incoming CDP messages/events on demand — no real socket.
class _FakeCdpSocket extends Stream<dynamic>
    implements BrowserTakeoverWebSocketLike {
  final StreamController<dynamic> _controller = StreamController<dynamic>();
  final List<Map<String, dynamic>> sent = [];
  bool closed = false;

  void pushMessage(Map<String, dynamic> message) =>
      _controller.add(jsonEncode(message));

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

/// Drives an already-connected fake socket (the one the test's own
/// `connector` callback created and handed to the client) through the
/// flatten-attach + screencast sequence exactly as a real Steel session
/// would respond. Operates on the SAME instance the client is talking to
/// — it must not create a new one, or the client would never see these
/// scripted responses.
Future<void> _driveAttachSequence(_FakeCdpSocket fake) async {
  // Real event-loop turns are needed between each response so the
  // client's own async message handling has a chance to run before the
  // next scripted response is pushed.
  await Future<void>.delayed(Duration.zero);
  fake.pushMessage({
    'id': 1,
    'result': {
      'targetInfos': [
        {'targetId': 'page-1', 'type': 'page'},
      ],
    },
  });
  await Future<void>.delayed(Duration.zero);
  fake.pushMessage({
    'id': 2,
    'result': {'sessionId': 'session-1'},
  });
  await Future<void>.delayed(Duration.zero);
}

void main() {
  group('BrowserTakeoverClient.takeover — flatten-attach sequence', () {
    test(
      'performs Target.getTargets -> Target.attachToTarget(flatten:true) -> Page.startScreencast, in order',
      () async {
        final fake = FakeHttpClient();
        final apiClient = await _loggedIn(fake);
        late _FakeCdpSocket socket;
        BrowserTakeoverClient(
          apiClient: apiClient,
          connector: (url, {headers}) async {
            expect(url, 'ws://localhost:3000/runs/run-1/browser-takeover');
            socket = _FakeCdpSocket();
            return socket;
          },
        ).takeover(
          runId: 'run-1',
          onFrame: (_) {},
          onDone: () {},
        );

        await Future<void>.delayed(Duration.zero);
        expect(socket.sent, hasLength(1));
        expect(socket.sent[0]['method'], 'Target.getTargets');

        socket.pushMessage({
          'id': 1,
          'result': {
            'targetInfos': [
              {'targetId': 'page-1', 'type': 'page'},
            ],
          },
        });
        await Future<void>.delayed(Duration.zero);
        expect(socket.sent, hasLength(2));
        expect(socket.sent[1]['method'], 'Target.attachToTarget');
        expect(socket.sent[1]['params'], {
          'targetId': 'page-1',
          'flatten': true,
        });

        socket.pushMessage({
          'id': 2,
          'result': {'sessionId': 'session-1'},
        });
        await Future<void>.delayed(Duration.zero);
        expect(socket.sent, hasLength(3));
        expect(socket.sent[2]['method'], 'Page.startScreencast');
        expect(socket.sent[2]['sessionId'], 'session-1');
      },
    );

    test('decodes real screencast frames and acknowledges each one', () async {
      final fake = FakeHttpClient();
      final apiClient = await _loggedIn(fake);
      late _FakeCdpSocket socket;
      final frames = <List<int>>[];
      BrowserTakeoverClient(
        apiClient: apiClient,
        connector: (url, {headers}) async {
          socket = _FakeCdpSocket();
          return socket;
        },
      ).takeover(runId: 'run-1', onFrame: frames.add, onDone: () {});

      await Future<void>.delayed(Duration.zero);
      await _driveAttachSequence(socket);
      final rawBytes = utf8.encode('a real jpeg (fixture bytes)');
      final beforeAck = socket.sent.length;
      socket.pushMessage({
        'method': 'Page.screencastFrame',
        'params': {'data': base64Encode(rawBytes), 'sessionId': 'frame-sid'},
      });
      await Future<void>.delayed(Duration.zero);

      expect(frames, hasLength(1));
      expect(frames[0], rawBytes);
      // The frame must be acknowledged (CDP pauses the feed until acked).
      final ack = socket.sent.skip(beforeAck).firstWhere(
            (m) => m['method'] == 'Page.screencastFrameAck',
          );
      expect(ack['params'], {'sessionId': 'frame-sid'});
    });
  });

  group('BrowserTakeoverSubscription — real input dispatch', () {
    test(
      'tap() sends a real mousePressed/mouseReleased pair riding the attached sessionId',
      () async {
        final fake = FakeHttpClient();
        final apiClient = await _loggedIn(fake);
        late _FakeCdpSocket socket;
        final subscription = BrowserTakeoverClient(
          apiClient: apiClient,
          connector: (url, {headers}) async {
            socket = _FakeCdpSocket();
            return socket;
          },
        ).takeover(runId: 'run-1', onFrame: (_) {}, onDone: () {});

        await Future<void>.delayed(Duration.zero);
        await _driveAttachSequence(socket);
        final before = socket.sent.length;
        subscription.tap(120.5, 300.25);
        await Future<void>.delayed(Duration.zero);

        final mouseEvents = socket.sent.skip(before).toList();
        expect(mouseEvents, hasLength(2));
        expect(mouseEvents[0], containsPair('sessionId', 'session-1'));
        expect(mouseEvents[0]['params'], {
          'type': 'mousePressed',
          'x': 120.5,
          'y': 300.25,
          'button': 'left',
          'clickCount': 1,
        });
        expect(mouseEvents[1]['params']['type'], 'mouseReleased');
      },
    );

    test('typeText() sends one char key event per character, in order', () async {
      final fake = FakeHttpClient();
      final apiClient = await _loggedIn(fake);
      late _FakeCdpSocket socket;
      final subscription = BrowserTakeoverClient(
        apiClient: apiClient,
        connector: (url, {headers}) async {
          socket = _FakeCdpSocket();
          return socket;
        },
      ).takeover(runId: 'run-1', onFrame: (_) {}, onDone: () {});

      await Future<void>.delayed(Duration.zero);
      await _driveAttachSequence(socket);
      final before = socket.sent.length;
      subscription.typeText('42');
      await Future<void>.delayed(Duration.zero);

      final keyEvents = socket.sent.skip(before).toList();
      expect(keyEvents, hasLength(2));
      expect(keyEvents[0]['params'], {'type': 'char', 'text': '4'});
      expect(keyEvents[1]['params'], {'type': 'char', 'text': '2'});
    });

    test(
      'queues input sent before flatten-attach completes and flushes it once a sessionId exists — no dropped keystrokes',
      () async {
        final fake = FakeHttpClient();
        final apiClient = await _loggedIn(fake);
        late _FakeCdpSocket socket;
        final subscription = BrowserTakeoverClient(
          apiClient: apiClient,
          connector: (url, {headers}) async {
            socket = _FakeCdpSocket();
            return socket;
          },
        ).takeover(runId: 'run-1', onFrame: (_) {}, onDone: () {});

        await Future<void>.delayed(Duration.zero);
        // Attach not complete yet — this must be queued, not dropped.
        subscription.dispatchKey('Enter');
        expect(
          socket.sent.where((m) => m['method'] == 'Input.dispatchKeyEvent'),
          isEmpty,
        );

        socket.pushMessage({
          'id': 1,
          'result': {
            'targetInfos': [
              {'targetId': 'page-1', 'type': 'page'},
            ],
          },
        });
        await Future<void>.delayed(Duration.zero);
        socket.pushMessage({
          'id': 2,
          'result': {'sessionId': 'session-1'},
        });
        await Future<void>.delayed(Duration.zero);

        final keyEvents = socket.sent
            .where((m) => m['method'] == 'Input.dispatchKeyEvent')
            .toList();
        expect(keyEvents, hasLength(2));
        expect(keyEvents[0]['params'], {
          'type': 'keyDown',
          'key': 'Enter',
          'code': 'Enter',
          'windowsVirtualKeyCode': 13,
          'nativeVirtualKeyCode': 13,
          'text': '\r',
        });
        expect(keyEvents[1]['params'], {
          'type': 'keyUp',
          'key': 'Enter',
          'code': 'Enter',
          'windowsVirtualKeyCode': 13,
          'nativeVirtualKeyCode': 13,
        });
        expect(keyEvents[0]['sessionId'], 'session-1');
      },
    );

    test('close() stops further input from being sent, even a queued tap', () async {
      final fake = FakeHttpClient();
      final apiClient = await _loggedIn(fake);
      late _FakeCdpSocket socket;
      final subscription = BrowserTakeoverClient(
        apiClient: apiClient,
        connector: (url, {headers}) async {
          socket = _FakeCdpSocket();
          return socket;
        },
      ).takeover(runId: 'run-1', onFrame: (_) {}, onDone: () {});

      await Future<void>.delayed(Duration.zero);
      await _driveAttachSequence(socket);
      subscription.close();
      expect(socket.closed, isTrue);
      final before = socket.sent.length;
      subscription.tap(10, 10);
      subscription.typeText('x');
      subscription.dispatchKey('Tab');
      await Future<void>.delayed(Duration.zero);
      expect(socket.sent.length, before);
    });

    test('Backspace, Tab, unknown keys and chars send the exact CDP payloads', () async {
      final fake = FakeHttpClient();
      final apiClient = await _loggedIn(fake);
      late _FakeCdpSocket socket;
      final sub = BrowserTakeoverClient(
        apiClient: apiClient,
        connector: (url, {headers}) async {
          socket = _FakeCdpSocket();
          return socket;
        },
      ).takeover(runId: 'run-1', onFrame: (_) {}, onDone: () {});
      await Future<void>.delayed(Duration.zero);
      await _driveAttachSequence(socket);
      final base = socket.sent.length;
      sub.dispatchKey('Backspace');
      sub.dispatchKey('Tab');
      sub.dispatchKey('Escape');
      sub.typeText('a');
      final p = socket.sent
          .skip(base)
          .where((m) => m['method'] == 'Input.dispatchKeyEvent')
          .map((m) => m['params'])
          .toList();
      expect(p, [
        {'type': 'rawKeyDown', 'key': 'Backspace', 'code': 'Backspace', 'windowsVirtualKeyCode': 8, 'nativeVirtualKeyCode': 8},
        {'type': 'keyUp', 'key': 'Backspace', 'code': 'Backspace', 'windowsVirtualKeyCode': 8, 'nativeVirtualKeyCode': 8},
        {'type': 'rawKeyDown', 'key': 'Tab', 'code': 'Tab', 'windowsVirtualKeyCode': 9, 'nativeVirtualKeyCode': 9},
        {'type': 'keyUp', 'key': 'Tab', 'code': 'Tab', 'windowsVirtualKeyCode': 9, 'nativeVirtualKeyCode': 9},
        {'type': 'rawKeyDown', 'key': 'Escape'},
        {'type': 'keyUp', 'key': 'Escape'},
        {'type': 'char', 'text': 'a'},
      ]);
    });
  });
}
