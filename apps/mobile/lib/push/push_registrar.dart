import 'dart:async';

import '../api/api_client.dart';
import 'push_message.dart';
import 'push_port.dart';

/// TASK-149 (Mobile Wave 2b) — orchestrates the client half of push: obtain
/// the FCM token, register it via `POST /devices` (authenticated with the
/// session cookie [ApiClient] already carries), re-register on rotation,
/// and forward decoded foreground messages to the caller for display.
///
/// Registration failures (network blip, server rejecting the request) are
/// deliberately swallowed after being surfaced once via [onRegistrationError]
/// — push is additive, never load-bearing, so it must never crash or block
/// the rest of the app. The device token itself is never logged, here or
/// anywhere downstream; only its presence/absence is ever reported.
class PushRegistrar {
  PushRegistrar({
    required ApiClient apiClient,
    required PushPort port,
    required String Function() devicePlatform,
    void Function(PushMessage message)? onMessage,
    void Function(Object error)? onRegistrationError,
  })  : _apiClient = apiClient,
        _port = port,
        _devicePlatform = devicePlatform,
        _onMessage = onMessage,
        _onRegistrationError = onRegistrationError;

  final ApiClient _apiClient;
  final PushPort _port;
  final String Function() _devicePlatform;
  final void Function(PushMessage message)? _onMessage;
  final void Function(Object error)? _onRegistrationError;

  StreamSubscription<String>? _tokenSub;
  StreamSubscription<PushMessage>? _messageSub;
  bool _initialized = false;

  /// True once a token has been obtained and successfully registered at
  /// least once. Exposed for tests/diagnostics only.
  bool get hasRegistered => _hasRegistered;
  bool _hasRegistered = false;

  /// Idempotent: calling more than once is a no-op after the first call
  /// completes its initial-token attempt.
  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;

    _messageSub = _port.onForegroundMessage.listen(_onMessage);
    _tokenSub = _port.onTokenRefresh.listen(_register);

    final initialToken = await _port.getToken();
    if (initialToken != null) {
      await _register(initialToken);
    }
  }

  Future<void> _register(String token) async {
    try {
      await _apiClient.registerDevice(token, _devicePlatform());
      _hasRegistered = true;
    } catch (error) {
      _onRegistrationError?.call(error);
    }
  }

  /// TASK-232 — resets [_initialized] so a caller can [initialize] again
  /// after this (e.g. the user turns notifications off, then back on,
  /// within the same session) rather than being permanently latched off
  /// by the single-shot guard `initialize` uses on first call.
  void dispose() {
    _tokenSub?.cancel();
    _messageSub?.cancel();
    _port.dispose();
    _initialized = false;
    _hasRegistered = false;
  }
}
