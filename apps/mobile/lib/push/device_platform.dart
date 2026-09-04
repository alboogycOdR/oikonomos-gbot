import 'package:flutter/foundation.dart';

/// TASK-149 (Mobile Wave 2b) — maps Flutter's [TargetPlatform] onto the
/// exact wire values `services/control-api/src/app.ts`'s
/// `REGISTER_DEVICE_SCHEMA` accepts (`packages/db/src/deviceTokens.ts`'s
/// `devicePlatforms`: `"android" | "ios" | "web"`).
String currentDevicePlatform() {
  if (kIsWeb) return 'web';
  switch (defaultTargetPlatform) {
    case TargetPlatform.android:
      return 'android';
    case TargetPlatform.iOS:
      return 'ios';
    default:
      // Desktop targets have no FCM path today; registration is skipped
      // upstream (no token is ever obtained from a Noop/desktop port), so
      // this value is never actually sent — it exists only so the
      // function is total.
      return 'web';
  }
}
