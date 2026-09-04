import 'dart:async';

import 'package:oikonomos_mobile/push/push_message.dart';
import 'package:oikonomos_mobile/push/push_port.dart';

/// TASK-149 (Mobile Wave 2b) — test double for [PushPort]. Lets a test
/// script an initial token, push rotations, and foreground messages
/// without any real Firebase/platform-channel involvement.
class FakePushPort implements PushPort {
  FakePushPort({String? initialToken}) : _initialToken = initialToken;

  final String? _initialToken;
  final StreamController<String> _tokenRefresh =
      StreamController<String>.broadcast();
  final StreamController<PushMessage> _messages =
      StreamController<PushMessage>.broadcast();

  bool disposed = false;
  int getTokenCallCount = 0;

  @override
  Future<String?> getToken() async {
    getTokenCallCount++;
    return _initialToken;
  }

  @override
  Stream<String> get onTokenRefresh => _tokenRefresh.stream;

  @override
  Stream<PushMessage> get onForegroundMessage => _messages.stream;

  void emitTokenRefresh(String token) => _tokenRefresh.add(token);

  void emitMessage(PushMessage message) => _messages.add(message);

  @override
  void dispose() {
    disposed = true;
    _tokenRefresh.close();
    _messages.close();
  }
}
