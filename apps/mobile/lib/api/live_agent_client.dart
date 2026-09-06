import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'api_client.dart';
import 'exceptions.dart';

/// TASK-171 — status + live PTY-viewer stream for a role's most recent/
/// active OpenSandbox sandbox run, backed by
/// `services/control-api/src/liveAgent.routes.ts`.
///
/// Deliberately has no `send`/`write` method of any kind: the AC1
/// guarantee ("the viewer connection genuinely cannot inject input") is
/// enforced server-side (see `liveAgent.routes.ts`'s `relay()`), but this
/// client reinforces it structurally too — there is no code path here
/// that could ever transmit a byte upstream even if a caller wanted to.

/// A role's live-agent availability, mirroring `GET
/// /roles/:roleId/live-agent/status`'s response shape exactly.
class LiveAgentStatus {
  const LiveAgentStatus({required this.available, this.state});

  final bool available;
  final String? state;

  static LiveAgentStatus fromJson(Map<String, dynamic> json) {
    return LiveAgentStatus(
      available: json['available'] as bool,
      state: json['state'] as String?,
    );
  }
}

/// Injectable WebSocket dial so tests never open a real socket — same
/// shape as `dart:io`'s `WebSocket.connect`, mirroring
/// `realtime/sse_client.dart`'s injectable-transport pattern for its own
/// `http.Client`.
typedef WebSocketConnector = Future<WebSocketLike> Function(
  String url, {
  Map<String, dynamic>? headers,
});

/// The subset of `dart:io`'s `WebSocket` this client depends on, so a
/// fake can implement it without opening a real socket.
abstract class WebSocketLike implements Stream<dynamic> {
  Future<void> close();
}

WebSocketLike _wrapRealWebSocket(WebSocket socket) => _RealWebSocket(socket);

class _RealWebSocket extends Stream<dynamic> implements WebSocketLike {
  _RealWebSocket(this._socket);
  final WebSocket _socket;

  @override
  StreamSubscription<dynamic> listen(
    void Function(dynamic event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return _socket.listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }

  @override
  Future<void> close() => _socket.close();
}

Future<WebSocketLike> _defaultConnector(
  String url, {
  Map<String, dynamic>? headers,
}) async {
  final socket = await WebSocket.connect(url, headers: headers);
  return _wrapRealWebSocket(socket);
}

/// Handle for one open (or connecting) live-agent viewer stream. Call
/// [close] when the screen is disposed or the role is switched away
/// from — idempotent.
class LiveAgentSubscription {
  LiveAgentSubscription._(this._close);

  final void Function() _close;
  bool _closed = false;

  void close() {
    if (_closed) return;
    _closed = true;
    _close();
  }
}

class LiveAgentClient {
  LiveAgentClient({required this.apiClient, WebSocketConnector? connector})
      : _connector = connector ?? _defaultConnector;

  final ApiClient apiClient;
  final WebSocketConnector _connector;

  /// `GET /roles/:roleId/live-agent/status`. A `501` (backend not yet
  /// wired to a real sandbox source, see the route's own doc comment)
  /// is treated the same as "nothing to show" — never surfaced as an
  /// error, since from the viewer's perspective both mean the same
  /// thing: no live session to display.
  Future<LiveAgentStatus> getStatus(String roleId) async {
    final uri = Uri.parse(
      '${apiClient.baseUrl}/roles/${Uri.encodeComponent(roleId)}/live-agent/status',
    );
    final response = await apiClient.httpClient.get(
      uri,
      headers: apiClient.cookieHeaders,
    );
    if (response.statusCode == 401) {
      throw const UnauthorizedError();
    }
    if (response.statusCode == 501) {
      return const LiveAgentStatus(available: false);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException(
        'live-agent status request failed with ${response.statusCode}',
      );
    }
    final decoded = jsonDecode(response.body) as Map<String, dynamic>;
    return LiveAgentStatus.fromJson(decoded);
  }

  /// Opens the read-only PTY viewer stream (execd's `mode=viewer&since=0`
  /// — replay of everything so far, then live). [onOutput] fires once per
  /// chunk of real sandbox output, in arrival order; this is never
  /// mocked/placeholder content. [onDone] fires once the sandbox session
  /// ends or the server closes the stream (e.g. no active/recent
  /// session — the caller should have checked [getStatus] first, but a
  /// race is handled gracefully here, not as an error).
  LiveAgentSubscription watch({
    required String roleId,
    required void Function(String output) onOutput,
    required void Function() onDone,
    void Function(Object error)? onError,
  }) {
    var closed = false;
    WebSocketLike? socket;
    StreamSubscription<dynamic>? subscription;

    final scheme = apiClient.baseUrl.startsWith('https://') ? 'wss' : 'ws';
    final wsBase = apiClient.baseUrl.replaceFirst(RegExp('^https?'), scheme);
    final url =
        '$wsBase/roles/${Uri.encodeComponent(roleId)}/live-agent/pty';

    unawaited(() async {
      try {
        final ws = await _connector(url, headers: apiClient.cookieHeaders);
        if (closed) {
          await ws.close();
          return;
        }
        socket = ws;
        subscription = ws.listen(
          (dynamic event) {
            if (event is String) {
              onOutput(event);
            } else if (event is List<int>) {
              onOutput(utf8.decode(event, allowMalformed: true));
            }
          },
          onError: (Object error) => onError?.call(error),
          onDone: onDone,
          cancelOnError: true,
        );
      } catch (error) {
        if (!closed) onError?.call(error);
      }
    }());

    return LiveAgentSubscription._(() {
      closed = true;
      unawaited(subscription?.cancel());
      unawaited(socket?.close());
    });
  }
}
