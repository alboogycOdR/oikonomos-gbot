import 'push_message.dart';
import 'push_port.dart';

/// TASK-149 (Mobile Wave 2b) — the config-absent fallback. No Firebase
/// config file exists yet (and none may be committed per
/// WORKFLOW_MOBILE_W1_W2_2026-09-04.md), so this is the default port
/// everywhere: the app boots and behaves exactly as it did before push
/// existed. Every method is inert; nothing here ever touches a platform
/// channel.
class NoopPushPort implements PushPort {
  const NoopPushPort();

  @override
  Future<String?> getToken() async => null;

  @override
  Stream<String> get onTokenRefresh => const Stream.empty();

  @override
  Stream<PushMessage> get onForegroundMessage => const Stream.empty();

  @override
  void dispose() {}
}
