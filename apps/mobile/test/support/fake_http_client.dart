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
  final List<http.BaseRequest> requests = [];

  void queueJson(
    int statusCode,
    Object? body, {
    Map<String, String> headers = const {},
  }) {
    final encoded = body == null ? '' : jsonEncode(body);
    _responses.add(
      _QueuedResponse(statusCode: statusCode, body: encoded, headers: headers),
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

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    if (handler != null) {
      return handler!(request);
    }
    if (_responses.isEmpty) {
      throw StateError('FakeHttpClient: no queued response for ${request.url}');
    }
    final queued = _responses.removeAt(0);
    final bytes = utf8.encode(queued.body);
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
  });

  final int statusCode;
  final String body;
  final Map<String, String> headers;
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
