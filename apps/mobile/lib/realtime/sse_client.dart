import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../api/exceptions.dart';
import '../api/models.dart';

/// TASK-144 (Mobile Wave 1a) — Dart port of
/// `apps/dashboard/src/lib/realtime.ts`'s hand-rolled SSE reader, mirroring
/// its resume semantics exactly: every frame is `id: <message
/// id>\ndata: <json>\n\n`; the last processed `id` is remembered and sent
/// back as `Last-Event-ID` on every reconnect, so a resumed stream never
/// repeats a message already delivered and never skips one that arrived
/// while disconnected. Built on a raw streamed HTTP request (`http`
/// package's `Client.send`) rather than any `EventSource`-style API — Dart
/// has no built-in browser `EventSource`, and a hand-rolled reader is
/// directly testable against a fake [http.Client] with no real socket.
class SseSubscription {
  SseSubscription._(this._close);

  final void Function() _close;

  /// Tears down the stream and any pending reconnect timer. Idempotent.
  void close() => _close();
}

/// Opens (and, on drop, silently reconnects) a push subscription for one
/// thread's messages. [onMessage] fires once per message, in arrival
/// order, exactly once per message id. Call [SseSubscription.close] when
/// the thread is switched away from or the screen is disposed.
SseSubscription subscribeToThreadMessages({
  required String baseUrl,
  required String threadId,
  required void Function(ThreadMessage message) onMessage,
  void Function(Object error)? onError,
  Map<String, String> Function()? authHeaders,
  http.Client? httpClient,
  Duration reconnectDelay = const Duration(milliseconds: 500),
}) {
  final connection = _SseConnection(
    uri: Uri.parse(
      '${_stripTrailingSlash(baseUrl)}/threads/${Uri.encodeComponent(threadId)}/stream',
    ),
    onMessage: onMessage,
    onError: onError,
    authHeaders: authHeaders,
    client: httpClient ?? http.Client(),
    ownsClient: httpClient == null,
    reconnectDelay: reconnectDelay,
  );
  connection.start();
  return SseSubscription._(connection.close);
}

/// Holds the mutable state for one subscription's connect/reconnect
/// lifecycle. A class (rather than mutually-referencing local closures)
/// so `connectOnce` and `scheduleReconnect` can call each other regardless
/// of declaration order.
class _SseConnection {
  _SseConnection({
    required this.uri,
    required this.onMessage,
    required this.onError,
    required this.authHeaders,
    required this.client,
    required this.ownsClient,
    required this.reconnectDelay,
  });

  final Uri uri;
  final void Function(ThreadMessage message) onMessage;
  final void Function(Object error)? onError;
  final Map<String, String> Function()? authHeaders;
  final http.Client client;
  final bool ownsClient;
  final Duration reconnectDelay;

  bool _closed = false;
  String? _lastEventId;
  Timer? _reconnectTimer;
  StreamSubscription<List<int>>? _byteSubscription;

  void start() {
    unawaited(_connectOnce());
  }

  void _scheduleReconnect() {
    if (_closed) return;
    _reconnectTimer = Timer(reconnectDelay, () => unawaited(_connectOnce()));
  }

  void _processFrame(String rawFrame) {
    if (rawFrame.startsWith(':')) return; // comment/heartbeat
    String? id;
    String? data;
    for (final line in rawFrame.split('\n')) {
      if (line.startsWith('id:')) {
        id = line.substring(3).trim();
      } else if (line.startsWith('data:')) {
        data = (data ?? '') + line.substring(5).trim();
      }
    }
    if (id != null) {
      _lastEventId = id;
    }
    if (data == null || data.isEmpty) return;
    try {
      final decoded = jsonDecode(data) as Map<String, dynamic>;
      onMessage(ThreadMessage.fromJson(decoded));
    } catch (_) {
      // Malformed frame — drop it rather than crash the subscription.
    }
  }

  Future<void> _connectOnce() async {
    if (_closed) return;
    var buffer = '';
    try {
      final request = http.Request('GET', uri);
      final extraHeaders = authHeaders?.call() ?? const {};
      request.headers.addAll(extraHeaders);
      if (_lastEventId != null) {
        request.headers['last-event-id'] = _lastEventId!;
      }
      final streamedResponse = await client.send(request);
      if (_closed) return;
      if (streamedResponse.statusCode == 401) {
        throw const UnauthorizedError();
      }
      if (streamedResponse.statusCode < 200 ||
          streamedResponse.statusCode >= 300) {
        throw ApiException(
          'stream request failed with ${streamedResponse.statusCode}',
        );
      }
      final completer = Completer<void>();
      _byteSubscription = streamedResponse.stream.listen(
        (chunk) {
          buffer += utf8.decode(chunk, allowMalformed: true);
          var separatorIndex = buffer.indexOf('\n\n');
          while (separatorIndex != -1) {
            final rawFrame = buffer.substring(0, separatorIndex);
            buffer = buffer.substring(separatorIndex + 2);
            _processFrame(rawFrame);
            separatorIndex = buffer.indexOf('\n\n');
          }
        },
        onError: (Object error) {
          if (!completer.isCompleted) completer.completeError(error);
        },
        onDone: () {
          if (!completer.isCompleted) completer.complete();
        },
        cancelOnError: true,
      );
      await completer.future;
    } catch (error) {
      if (_closed) return;
      onError?.call(error);
      if (error is UnauthorizedError) {
        // No session can come back on its own — further reconnect
        // attempts would just keep hammering the endpoint with 401s
        // until the caller re-authenticates and opens a fresh
        // subscription.
        return;
      }
      _scheduleReconnect();
      return;
    }
    // The stream ended (server closed it) with no error: reconnect
    // unless close() has already been called.
    _scheduleReconnect();
  }

  void close() {
    if (_closed) return;
    _closed = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _byteSubscription?.cancel();
    if (ownsClient) {
      client.close();
    }
  }
}

String _stripTrailingSlash(String url) =>
    url.endsWith('/') ? url.substring(0, url.length - 1) : url;
