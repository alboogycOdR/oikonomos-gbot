import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// Test double implementing [http.BaseClient] so the API/SSE clients can
/// be exercised without any real network I/O — records every request it
/// sees and answers from a queue of canned responses (or a handler
/// function for stream tests that need per-request behavior, e.g.
/// asserting the `Last-Event-ID` header on a reconnect).
class FakeHttpClient extends http.BaseClient {
  FakeHttpClient({this.handler});

  /// Optional handler; if set, overrides the [responses] queue entirely.
  Future<http.StreamedResponse> Function(http.BaseRequest request)? handler;

  final List<_QueuedResponse> _responses = [];
  final Map<String, List<_QueuedResponse>> _pathResponses = {};
  final List<http.BaseRequest> requests = [];

  void queueJson(
    int statusCode,
    Object? body, {
    Map<String, String> headers = const {},
    Duration? delay,
  }) {
    final encoded = body == null ? '' : jsonEncode(body);
    _responses.add(
      _QueuedResponse(
        statusCode: statusCode,
        body: encoded,
        headers: headers,
        delay: delay,
      ),
    );
  }

  void queueRaw(
    int statusCode,
    String body, {
    Map<String, String> headers = const {},
  }) {
    _responses.add(
      _QueuedResponse(statusCode: statusCode, body: body, headers: headers),
    );
  }

  /// Queues a response for one exact method/path pair without consuming the
  /// chronological queue used by existing screen tests. This keeps optional
  /// background requests from shifting the response intended for the primary
  /// user interaction under test.
  void queueJsonFor(
    String method,
    String path,
    int statusCode,
    Object? body, {
    Map<String, String> headers = const {},
  }) {
    final encoded = body == null ? '' : jsonEncode(body);
    final key = _requestKey(method, path);
    (_pathResponses[key] ??= []).add(
      _QueuedResponse(statusCode: statusCode, body: encoded, headers: headers),
    );
  }

  /// TASK-147 (Mobile Wave 1b) — queues a response whose body stream is
  /// never closed, simulating a real SSE connection held open
  /// indefinitely. Without this, every queued SSE response completes
  /// immediately and `SseSubscription` schedules a reconnect `Timer`,
  /// which `flutter_test` reports as a leaked pending timer unless a
  /// test carefully times its teardown around it. A widget test that
  /// reaches `ChatScreen`'s live subscription queues this for the
  /// `/stream` request instead, and disposes the screen (which cancels
  /// the subscription, not a Timer) to clean up.
  void queueHangingStream(int statusCode,
      {Map<String, String> headers = const {}}) {
    _responses.add(
      _QueuedResponse(statusCode: statusCode, body: null, headers: headers),
    );
  }

  /// Like [queueHangingStream], but the caller keeps the [StreamController]
  /// and can push additional SSE frames into it after the request has
  /// been answered — used by tests asserting that a *live* pushed event
  /// (arriving after the widget has already mounted) is rendered.
  /// The caller is responsible for closing the controller once done.
  StreamController<List<int>> queueControlledStream(
    int statusCode, {
    Map<String, String> headers = const {},
  }) {
    final controller = StreamController<List<int>>();
    _responses.add(
      _QueuedResponse(
        statusCode: statusCode,
        body: null,
        headers: headers,
        stream: controller.stream,
      ),
    );
    return controller;
  }

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    if (handler != null) {
      return handler!(request);
    }
    final pathResponses =
        _pathResponses[_requestKey(request.method, request.url.path)];
    if (pathResponses != null && pathResponses.isNotEmpty) {
      return _toStreamedResponse(pathResponses.removeAt(0));
    }
    // Handoffs are non-essential timeline decoration. Existing ChatScreen
    // tests intentionally only script the transcript and live stream, so
    // model the normal no-handoffs response without consuming their queues.
    if (request.method == 'GET' &&
        RegExp(r'^/roles/[^/]+/messages$').hasMatch(request.url.path)) {
      return _toStreamedResponse(
        _QueuedResponse(statusCode: 200, body: '[]', headers: const {}),
      );
    }
    if (_responses.isEmpty) {
      throw StateError('FakeHttpClient: no queued response for ${request.url}');
    }
    final queued = _responses.removeAt(0);
    if (queued.delay != null) {
      await Future<void>.delayed(queued.delay!);
    }
    return _toStreamedResponse(queued);
  }

  String _requestKey(String method, String path) =>
      '${method.toUpperCase()} $path';

  http.StreamedResponse _toStreamedResponse(_QueuedResponse queued) {
    if (queued.stream != null) {
      return http.StreamedResponse(
        queued.stream!,
        queued.statusCode,
        headers: queued.headers,
      );
    }
    if (queued.body == null) {
      final controller =
          StreamController<Uint8List>(); // deliberately never closed
      return http.StreamedResponse(
        controller.stream,
        queued.statusCode,
        headers: queued.headers,
      );
    }
    final bytes = utf8.encode(queued.body!);
    return http.StreamedResponse(
      Stream.value(bytes),
      queued.statusCode,
      headers: queued.headers,
    );
  }
}

class _QueuedResponse {
  _QueuedResponse({
    required this.statusCode,
    required this.body,
    required this.headers,
    this.stream,
    this.delay,
  });

  final int statusCode;
  final String? body;
  final Map<String, String> headers;
  final Stream<List<int>>? stream;
  final Duration? delay;
}

/// Builds a [http.StreamedResponse] whose body stream yields [chunks] one
/// at a time (each delayed slightly via a microtask) — used by SSE tests
/// to simulate frames arriving over time and to allow a test to trigger a
/// "dropped connection" by closing the stream controller early.
http.StreamedResponse streamedResponseFromChunks(
  List<List<int>> chunks, {
  int statusCode = 200,
  Map<String, String> headers = const {},
}) {
  final controller = StreamController<Uint8List>();
  Future(() async {
    for (final chunk in chunks) {
      controller.add(Uint8List.fromList(chunk));
      await Future<void>.delayed(Duration.zero);
    }
    await controller.close();
  });
  return http.StreamedResponse(controller.stream, statusCode, headers: headers);
}
