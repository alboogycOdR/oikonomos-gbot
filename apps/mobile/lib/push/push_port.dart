import 'push_message.dart';

/// TASK-149 (Mobile Wave 2b) — messaging-layer abstraction so all
/// registration/rotation/foreground-display logic ([PushRegistrar]) is
/// testable against a fake, with no real Firebase SDK involved in any test.
/// [FirebasePushPort] (real, `firebase_messaging`-backed) and
/// [NoopPushPort] (config-absent fallback) are the only two production
/// implementations; tests supply their own fake.
abstract class PushPort {
  /// The current FCM registration token, or `null` if push is dormant
  /// (config absent) or the token could not be obtained yet.
  Future<String?> getToken();

  /// Emits a new token whenever the platform rotates it. Never emits for a
  /// dormant port.
  Stream<String> get onTokenRefresh;

  /// Emits a decoded [PushMessage] for every foreground data message the
  /// two backend triggers send. Never emits for a dormant port.
  Stream<PushMessage> get onForegroundMessage;

  /// Releases any underlying subscriptions. Safe to call more than once.
  void dispose();
}
