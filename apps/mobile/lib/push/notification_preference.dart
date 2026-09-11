import 'package:shared_preferences/shared_preferences.dart';

const _kNotificationsEnabledKey = 'notifications_enabled';

/// TASK-232 — persisted notifications preference. Defaults to enabled:
/// push has always been opt-out (registered automatically once a device
/// token is available) rather than opt-in, and this preference should not
/// silently change that default the first time it's read on an upgrade.
///
/// Backed by `shared_preferences`, which ships its own in-memory fake for
/// tests (`SharedPreferences.setMockInitialValues`) — no real platform
/// channel is touched by anything that uses this through a widget test.
class NotificationPreference {
  const NotificationPreference();

  Future<bool> isEnabled() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_kNotificationsEnabledKey) ?? true;
  }

  Future<void> setEnabled(bool enabled) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kNotificationsEnabledKey, enabled);
  }
}
