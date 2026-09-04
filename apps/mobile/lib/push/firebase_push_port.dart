import 'package:firebase_messaging/firebase_messaging.dart';

import 'push_message.dart';
import 'push_port.dart';

/// TASK-149 (Mobile Wave 2b) — the real, `firebase_messaging`-backed port.
/// Only ever constructed after `Firebase.initializeApp()` has already
/// succeeded (see `main.dart`'s config gate) — i.e. only when a real
/// `google-services.json`/`GoogleService-Info.plist` is present on the
/// device build. No test exercises this class: it is a thin, untestable-
/// without-a-real-SDK wrapper, and every behavior it delegates to is
/// covered against [PushPort] via a fake instead.
class FirebasePushPort implements PushPort {
  FirebasePushPort({FirebaseMessaging? messaging})
      : _messaging = messaging ?? FirebaseMessaging.instance;

  final FirebaseMessaging _messaging;

  @override
  Future<String?> getToken() => _messaging.getToken();

  @override
  Stream<String> get onTokenRefresh => _messaging.onTokenRefresh;

  @override
  Stream<PushMessage> get onForegroundMessage =>
      FirebaseMessaging.onMessage.map((message) => PushMessage.fromData(message.data)).where(
            (message) => message != null,
          ).cast<PushMessage>();

  @override
  void dispose() {}
}
