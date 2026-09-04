import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/realtime/sse_client.dart';

String frame(String id, Map<String, dynamic> message) =>
    'id: $id\ndata: ${jsonEncode(message)}\n\n';

Map<String, dynamic> messageJson(String id) => {
  'id': id,
  'threadId': 'thread-1',
  'role': 'user',
  'body': 'body-$id',
  'runId': null,
  'createdAt': '2026-09-04T00:00:00Z',
};

void main() {
  test('delivers events in order, one per message id', () async {
    final delivered = <String>[];
    late final Completer<void> done;
    done = Completer<void>();

    final client = _RecordingClient((request) async {
      final body =
          '${frame('1', messageJson('1'))}${frame('2', messageJson('2'))}';
      return http.StreamedResponse(
        Stream.value(utf8.encode(body)),
        200,
      );
    });

    final subscription = subscribeToThreadMessages(
      baseUrl: 'http://localhost:3000',
      threadId: 'thread-1',
      onMessage: (message) {
        delivered.add(message.id);
        if (delivered.length == 2) done.complete();
      },
      httpClient: client,
      reconnectDelay: const Duration(milliseconds: 10),
    );

    await done.future.timeout(const Duration(seconds: 2));
    subscription.close();

    expect(delivered, ['1', '2']);
  });

  test('resumes with Last-Event-ID after a dropped connection, no duplicate/missed events', () async {
    var attempt = 0;
    final delivered = <String>[];
    final done = Completer<void>();
    final capturedLastEventIds = <String?>[];

    final client = _RecordingClient((request) async {
      attempt += 1;
      capturedLastEventIds.add(request.headers['last-event-id']);
      if (attempt == 1) {
        // First connection: deliver message 1, then the stream drops
        // (ends) without a done id — simulates a lost connection.
        return http.StreamedResponse(Stream.value(utf8.encode(frame('1', messageJson('1')))), 200);
      }
      // Reconnect: server resumes after id "1", sends only message 2.
      return http.StreamedResponse(Stream.value(utf8.encode(frame('2', messageJson('2')))), 200);
    });

    final subscription = subscribeToThreadMessages(
      baseUrl: 'http://localhost:3000',
      threadId: 'thread-1',
      onMessage: (message) {
        delivered.add(message.id);
        if (delivered.length == 2) done.complete();
      },
      httpClient: client,
      reconnectDelay: const Duration(milliseconds: 10),
    );

    await done.future.timeout(const Duration(seconds: 2));
    subscription.close();

    expect(delivered, ['1', '2']);
    expect(capturedLastEventIds[0], isNull);
    expect(capturedLastEventIds[1], '1');
  });

  test('tears down cleanly on close() — no further reconnects', () async {
    var connectCount = 0;
    final client = _RecordingClient((request) async {
      connectCount += 1;
      return http.StreamedResponse(const Stream.empty(), 200);
    });

    final subscription = subscribeToThreadMessages(
      baseUrl: 'http://localhost:3000',
      threadId: 'thread-1',
      onMessage: (_) {},
      httpClient: client,
      reconnectDelay: const Duration(milliseconds: 10),
    );

    await Future<void>.delayed(const Duration(milliseconds: 5));
    subscription.close();
    final countAtClose = connectCount;
    await Future<void>.delayed(const Duration(milliseconds: 100));

    expect(connectCount, countAtClose);
  });

  test('stops on 401 without reconnecting', () async {
    var connectCount = 0;
    Object? capturedError;

    final client = _RecordingClient((request) async {
      connectCount += 1;
      return http.StreamedResponse(const Stream.empty(), 401);
    });

    final subscription = subscribeToThreadMessages(
      baseUrl: 'http://localhost:3000',
      threadId: 'thread-1',
      onMessage: (_) {},
      onError: (error) => capturedError = error,
      httpClient: client,
      reconnectDelay: const Duration(milliseconds: 10),
    );

    await Future<void>.delayed(const Duration(milliseconds: 100));
    subscription.close();

    expect(connectCount, 1);
    expect(capturedError, isNotNull);
  });

  test('sends configured auth headers on every request', () async {
    final headersSeen = <Map<String, String>>[];
    final client = _RecordingClient((request) async {
      headersSeen.add(request.headers);
      return http.StreamedResponse(const Stream.empty(), 200);
    });

    final subscription = subscribeToThreadMessages(
      baseUrl: 'http://localhost:3000',
      threadId: 'thread-1',
      onMessage: (_) {},
      authHeaders: () => {'cookie': 'control_api_session=abc123'},
      httpClient: client,
      reconnectDelay: const Duration(milliseconds: 500),
    );

    await Future<void>.delayed(const Duration(milliseconds: 50));
    subscription.close();

    expect(headersSeen, isNotEmpty);
    expect(headersSeen.first['cookie'], 'control_api_session=abc123');
  });
}

class _RecordingClient extends http.BaseClient {
  _RecordingClient(this._handler);

  final Future<http.StreamedResponse> Function(http.BaseRequest request) _handler;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) => _handler(request);
}
