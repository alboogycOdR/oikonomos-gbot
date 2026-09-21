import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'api_client.dart';
import 'exceptions.dart';

/// TASK-235 (G-07 part 2b) — the Steel/CDP-flavoured counterpart to
/// `live_agent_client.dart`'s `TakeoverSubscription`/`takeover`: instead of
/// execd's PTY (a text stream), this drives a real live browser page via
/// the Chrome DevTools Protocol, relayed byte-for-byte by
/// `services/control-api/src/browserTakeover.routes.ts`'s
/// `relayBrowserTakeover()` over `GET /runs/:id/browser-takeover`.
///
/// Unlike the PTY case, this client itself speaks CDP — the server-side
/// route deliberately never parses or rewrites CDP messages (see that
/// file's own header), so the flatten-attach sequence, screencast
/// subscription, and input dispatch all happen HERE, mirroring
/// `services/worker/src/geminiToolExecutors.ts`'s `runSteelCdp` (the
/// model's own equivalent CDP client for the SAME protocol quirk):
///
///   1. `Target.getTargets` — find the live page target. Steel's REST
///      session returns a BROWSER-level socket, not a page-level one;
///      `Page.*`/`Input.*` commands sent raw on it are rejected by CDP
///      itself (confirmed live, not assumed — see TASK-235's dossier and
///      `runSteelCdp`'s own header comment for the same finding).
///   2. `Target.attachToTarget({targetId, flatten: true})` — the standard
///      CDP "flatten" attach (https://chromedevtools.github.io/devtools-
///      protocol/#target-sessions). The returned `sessionId` then rides on
///      every subsequent command envelope and every incoming event, same
///      as `runSteelCdp`'s own sequence.
///   3. `Page.startScreencast` — subscribe to a live image feed of the
///      page. Each `Page.screencastFrame` event is decoded (base64 →
///      bytes) and handed to [onFrame]; every frame is acknowledged via
///      `Page.screencastFrameAck` (CDP pauses the feed until acked).
///   4. [BrowserTakeoverSubscription.tap]/[dispatchKey] send real
///      `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent` commands,
///      riding the same `sessionId` — genuine input, not a simulated
///      overlay.
///
/// Kept structurally separate from [LiveAgentClient]/[TakeoverSubscription]
/// rather than folding this in as another `kind` on that same type: the
/// wire protocol (CDP JSON-RPC-ish envelopes vs. raw PTY bytes) and the
/// interaction shape (frames + structured input vs. a text stream) are
/// different enough that a shared type would need its own internal branch
/// for "am I PTY or CDP" — the same anti-pattern the server side's own
/// `relay()`/`relayTakeover()` split (and now this file's own server
/// counterpart) already rejects for the same reason.

/// Injectable WebSocket dial so tests never open a real socket — same
/// shape `live_agent_client.dart`'s own `TakeoverConnector` uses.
typedef BrowserTakeoverConnector = Future<BrowserTakeoverWebSocketLike>
    Function(String url, {Map<String, dynamic>? headers});

/// The subset of `dart:io`'s `WebSocket` this client depends on, so a
/// fake can implement it without opening a real socket. Genuinely
/// bidirectional (unlike `live_agent_client.dart`'s read-only
/// `WebSocketLike`) — sending real CDP commands upstream is the entire
/// point of this client.
abstract class BrowserTakeoverWebSocketLike implements Stream<dynamic> {
  void add(dynamic data);
  Future<void> close();
}

class _RealBrowserTakeoverWebSocket extends Stream<dynamic>
    implements BrowserTakeoverWebSocketLike {
  _RealBrowserTakeoverWebSocket(this._socket);
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
  void add(dynamic data) => _socket.add(data);

  @override
  Future<void> close() => _socket.close();
}

Future<BrowserTakeoverWebSocketLike> _defaultConnector(
  String url, {
  Map<String, dynamic>? headers,
}) async {
  final socket = await WebSocket.connect(url, headers: headers);
  return _RealBrowserTakeoverWebSocket(socket);
}

class _KeyDescriptor {
  const _KeyDescriptor(this.code, this.keyCode, [this.text]);
  final String code;
  final int keyCode;
  final String? text;
}

const _keyDescriptors = <String, _KeyDescriptor>{
  'Enter': _KeyDescriptor('Enter', 13, '\r'),
  'Backspace': _KeyDescriptor('Backspace', 8),
  'Tab': _KeyDescriptor('Tab', 9),
};

/// Handle for one open browser-takeover session. [tap]/[dispatchKey] send
/// genuine CDP input once the flatten-attach + screencast subscription
/// sequence has completed (buffered otherwise — see [_pendingInput]).
class BrowserTakeoverSubscription {
  BrowserTakeoverSubscription._(this._sendCommand, this._close);

  final void Function(String method, Map<String, dynamic> params) _sendCommand;
  final void Function() _close;
  bool _closed = false;

  /// Sends a real mouse click at CDP page coordinates `(x, y)` — a
  /// pressed then released `Input.dispatchMouseEvent` pair, the standard
  /// CDP idiom for a tap/click. A no-op once [close] has been called.
  void tap(double x, double y) {
    if (_closed) return;
    _sendCommand('Input.dispatchMouseEvent', {
      'type': 'mousePressed',
      'x': x,
      'y': y,
      'button': 'left',
      'clickCount': 1,
    });
    _sendCommand('Input.dispatchMouseEvent', {
      'type': 'mouseReleased',
      'x': x,
      'y': y,
      'button': 'left',
      'clickCount': 1,
    });
  }

  /// Types real text into whatever the page's active focus is (e.g. a
  /// password field, a 2FA code input) using CDP's `type: 'char'` key
  /// event — the standard idiom for injecting text without mapping every
  /// character to a platform key code. One event per character, in
  /// order, matching what a human physically typing would produce.
  void typeText(String text) {
    if (_closed) return;
    for (final rune in text.runes) {
      final char = String.fromCharCode(rune);
      _sendCommand('Input.dispatchKeyEvent', {'type': 'char', 'text': char});
    }
  }

  /// Sends one non-printable key (e.g. `Enter`, `Backspace`, `Tab`) as a
  /// real `rawKeyDown`/`keyUp` pair, CDP's own convention for keys that
  /// have no `char` text of their own.
  ///
  /// Chromium ignores an editing key whose event carries no
  /// `windowsVirtualKeyCode`, and only submits a form on Enter when a
  /// `keyDown` carries the carriage-return `text`. Known keys therefore get
  /// the full descriptor from [_keyDescriptors]; unknown keys keep the bare
  /// `key`-only pair.
  void dispatchKey(String key) {
    if (_closed) return;
    final d = _keyDescriptors[key];
    if (d == null) {
      _sendCommand('Input.dispatchKeyEvent', {'type': 'rawKeyDown', 'key': key});
      _sendCommand('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': key});
      return;
    }
    final base = <String, dynamic>{
      'key': key,
      'code': d.code,
      'windowsVirtualKeyCode': d.keyCode,
      'nativeVirtualKeyCode': d.keyCode,
    };
    _sendCommand('Input.dispatchKeyEvent', {
      'type': d.text == null ? 'rawKeyDown' : 'keyDown',
      ...base,
      if (d.text != null) 'text': d.text,
    });
    _sendCommand('Input.dispatchKeyEvent', {'type': 'keyUp', ...base});
  }

  void close() {
    if (_closed) return;
    _closed = true;
    _close();
  }
}

class BrowserTakeoverClient {
  BrowserTakeoverClient({
    required this.apiClient,
    BrowserTakeoverConnector? connector,
  }) : _connector = connector ?? _defaultConnector;

  final ApiClient apiClient;
  final BrowserTakeoverConnector _connector;

  /// Opens the browser-takeover WS (`GET /runs/:id/browser-takeover`),
  /// performs the flatten-attach + screencast-subscribe sequence, and
  /// streams decoded frames to [onFrame]. [onDone] fires once the
  /// connection closes (the server tears it down the instant hand-back
  /// completes — see `browserTakeover.routes.ts`'s own connect-time-only
  /// pending gate); [onError] surfaces a transport/protocol failure.
  BrowserTakeoverSubscription takeover({
    required String runId,
    required void Function(List<int> jpegBytes) onFrame,
    required void Function() onDone,
    void Function(Object error)? onError,
  }) {
    var closed = false;
    BrowserTakeoverWebSocketLike? socket;
    StreamSubscription<dynamic>? subscription;
    String? pageSessionId;
    var nextId = 1;
    final pendingUntilAttached = <void Function()>[];

    void sendRaw(Map<String, dynamic> envelope) {
      if (closed || socket == null) return;
      socket!.add(jsonEncode(envelope));
    }

    void sendCommand(String method, Map<String, dynamic> params) {
      if (pageSessionId == null) {
        // Real input must never race ahead of the attach sequence — queued
        // as a re-entrant call (not a pre-built envelope), so the flushed
        // command picks up the real `sessionId` once attach completes
        // rather than being sent with a stale/missing one. A fast typist
        // immediately after the view opens still lands every keystroke.
        pendingUntilAttached.add(() => sendCommand(method, params));
        return;
      }
      sendRaw({
        'id': nextId++,
        'method': method,
        'params': params,
        'sessionId': pageSessionId,
      });
    }

    void handleMessage(String raw) {
      Map<String, dynamic> message;
      try {
        message = jsonDecode(raw) as Map<String, dynamic>;
      } catch (error) {
        onError?.call(error);
        return;
      }

      // Response to Target.getTargets: find the first page target and
      // request flatten-attach to it.
      if (message['id'] == 1 && message['result'] != null) {
        final result = message['result'] as Map<String, dynamic>;
        final infos = (result['targetInfos'] as List<dynamic>?) ?? const [];
        final page = infos.cast<Map<String, dynamic>>().firstWhere(
              (info) => info['type'] == 'page',
              orElse: () => const {},
            );
        final targetId = page['targetId'] as String?;
        if (targetId == null) {
          onError?.call(const ApiException('no live page target to take over'));
          return;
        }
        sendRaw({
          'id': 2,
          'method': 'Target.attachToTarget',
          'params': {'targetId': targetId, 'flatten': true},
        });
        return;
      }

      // Response to Target.attachToTarget: now that a session exists,
      // start the screencast and flush anything queued during attach.
      if (message['id'] == 2 && message['result'] != null) {
        final result = message['result'] as Map<String, dynamic>;
        pageSessionId = result['sessionId'] as String?;
        if (pageSessionId == null) {
          onError?.call(const ApiException('flatten-attach did not return a sessionId'));
          return;
        }
        sendRaw({
          'id': nextId++,
          'method': 'Page.startScreencast',
          'params': {'format': 'jpeg', 'quality': 60},
          'sessionId': pageSessionId,
        });
        for (final flush in pendingUntilAttached) {
          flush();
        }
        pendingUntilAttached.clear();
        return;
      }

      // A live screencast frame: decode + hand to the caller, then ack
      // (CDP pauses the feed until every frame is acknowledged).
      if (message['method'] == 'Page.screencastFrame') {
        final params = message['params'] as Map<String, dynamic>;
        final data = params['data'] as String?;
        final sessionIdParam = params['sessionId'];
        if (data != null) {
          try {
            onFrame(base64Decode(data));
          } catch (error) {
            onError?.call(error);
          }
        }
        sendRaw({
          'id': nextId++,
          'method': 'Page.screencastFrameAck',
          'params': {'sessionId': sessionIdParam},
          if (pageSessionId != null) 'sessionId': pageSessionId,
        });
      }
    }

    unawaited(() async {
      final scheme = apiClient.baseUrl.startsWith('https://') ? 'wss' : 'ws';
      final wsBase =
          apiClient.baseUrl.replaceFirst(RegExp('^https?'), scheme);
      final url = '$wsBase/runs/${Uri.encodeComponent(runId)}/browser-takeover';
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
              handleMessage(event);
            } else if (event is List<int>) {
              handleMessage(utf8.decode(event, allowMalformed: true));
            }
          },
          onError: (Object error) => onError?.call(error),
          onDone: onDone,
          cancelOnError: true,
        );
        // Kick off the flatten-attach sequence.
        sendRaw({'id': 1, 'method': 'Target.getTargets', 'params': {}});
      } catch (error) {
        if (!closed) onError?.call(error);
      }
    }());

    return BrowserTakeoverSubscription._(
      sendCommand,
      () {
        closed = true;
        unawaited(subscription?.cancel());
        unawaited(socket?.close());
      },
    );
  }
}
