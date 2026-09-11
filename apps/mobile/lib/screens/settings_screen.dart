import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../api/api_client.dart';
import '../push/notification_preference.dart';
import 'login_screen.dart';

/// System-wide settings: the account that is signed in, sign out,
/// notification preference, and app version. Per-bot configuration
/// (instructions, skills, routines) stays on the bot's own settings
/// screen reached from the chat header.
class SystemSettingsScreen extends StatefulWidget {
  const SystemSettingsScreen({
    super.key,
    required this.apiClient,
    required this.authPort,
    this.notificationPreference = const NotificationPreference(),
    this.onNotificationsChanged,
  });

  final ApiClient apiClient;
  final GoogleAuthPort authPort;

  /// TASK-232 — persisted store for the toggle below. Read on open and
  /// written on every change, independent of [onNotificationsChanged], so
  /// this screen is fully testable/usable on its own (e.g. constructed
  /// directly in a test) without a live [RosterScreen] parent.
  final NotificationPreference notificationPreference;

  /// TASK-232 — optional live counterpart: when this screen is opened
  /// from [RosterScreen], this applies the change immediately to the
  /// running session's push registration (rather than only taking effect
  /// on next app start). Left null when this screen is exercised on its
  /// own, e.g. in tests.
  final Future<void> Function(bool enabled)? onNotificationsChanged;

  @override
  State<SystemSettingsScreen> createState() => _SystemSettingsScreenState();
}

class _SystemSettingsScreenState extends State<SystemSettingsScreen> {
  bool _notificationsEnabled = true;
  bool _signingOut = false;
  String? _version;

  @override
  void initState() {
    super.initState();
    _loadNotificationPreference();
    _loadVersion();
  }

  Future<void> _loadNotificationPreference() async {
    final enabled = await widget.notificationPreference.isEnabled();
    if (mounted) setState(() => _notificationsEnabled = enabled);
  }

  /// TASK-233 — reads the real build's version/build number rather than a
  /// hand-maintained constant. `package_info_plus` ships
  /// `PackageInfo.setMockInitialValues` for exactly this: widget tests
  /// never touch the real platform channel.
  Future<void> _loadVersion() async {
    final info = await PackageInfo.fromPlatform();
    if (!mounted) return;
    final build = info.buildNumber.trim();
    setState(() {
      _version = build.isEmpty ? info.version : '${info.version} ($build)';
    });
  }

  Future<void> _setNotificationsEnabled(bool enabled) async {
    setState(() => _notificationsEnabled = enabled);
    await widget.notificationPreference.setEnabled(enabled);
    await widget.onNotificationsChanged?.call(enabled);
  }

  /// Clears the in-memory session cookie and the real Firebase/Google
  /// session, then replaces the whole navigation stack with a fresh
  /// [LoginScreen] so back cannot return to a roster whose session is gone.
  Future<void> _signOut() async {
    if (_signingOut) return;
    setState(() => _signingOut = true);
    try {
      await LoginScreen.signOut(widget.apiClient, widget.authPort);
    } catch (_) {
      if (!mounted) return;
      setState(() => _signingOut = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not sign out. Try again.')),
      );
      return;
    }
    if (!mounted) return;
    await Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute<void>(
        builder: (_) => LoginScreen(apiClient: widget.apiClient),
      ),
      (route) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final profile = widget.authPort.currentProfile;
    final name = profile?.displayName?.trim();
    final email = profile?.email?.trim();
    final headline = (name != null && name.isNotEmpty)
        ? name
        : (email != null && email.isNotEmpty ? email : 'Signed in');
    final initial = headline.isNotEmpty ? headline[0].toUpperCase() : '?';
    final photoUrl = profile?.photoUrl;
    final colors = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          ListTile(
            key: const Key('settings-profile'),
            leading: CircleAvatar(
              key: const Key('settings-avatar'),
              backgroundColor: colors.primaryContainer,
              foregroundImage: (photoUrl != null && photoUrl.isNotEmpty)
                  ? NetworkImage(photoUrl)
                  : null,
              child: Text(
                initial,
                style: TextStyle(
                  color: colors.onPrimaryContainer,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
            title: Text(headline, key: const Key('settings-profile-name')),
            subtitle: (email != null && email.isNotEmpty && email != headline)
                ? Text(email, key: const Key('settings-profile-email'))
                : null,
          ),
          const Divider(),
          SwitchListTile(
            key: const Key('settings-notifications'),
            secondary: const Icon(Icons.notifications_outlined),
            title: const Text('Notifications'),
            subtitle: const Text('Approvals, take-over requests, and replies'),
            value: _notificationsEnabled,
            onChanged: (value) => _setNotificationsEnabled(value),
          ),
          const Divider(),
          ListTile(
            key: const Key('sign-out-button'),
            leading: Icon(Icons.logout, color: colors.error),
            title: Text('Sign out', style: TextStyle(color: colors.error)),
            enabled: !_signingOut,
            onTap: _signOut,
          ),
          const SizedBox(height: 32),
          Center(
            child: Text(
              _version == null ? 'OIKONOMOS' : 'OIKONOMOS $_version',
              key: const Key('settings-version'),
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: colors.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
  }
}
