import 'package:flutter/material.dart';

import '../api/api_client.dart';
import 'login_screen.dart';

/// App version shown at the foot of the settings screen. Kept in step with
/// `pubspec.yaml`'s `version:` by hand for now — `package_info_plus` would
/// read it at runtime but adds a platform channel the widget tests can't
/// reach; revisit when a release pipeline starts stamping builds.
const kAppVersion = '0.1.0';

/// System-wide settings: the account that is signed in, sign out,
/// notification preference, and app version. Per-bot configuration
/// (instructions, skills, routines) stays on the bot's own settings
/// screen reached from the chat header.
///
/// Notifications is a local preference only for now — nothing persists it
/// across launches and the push registrar does not yet consult it. It is
/// here so the screen has the shape the rest of the settings will grow
/// into, not because the switch already gates anything.
class SystemSettingsScreen extends StatefulWidget {
  const SystemSettingsScreen({
    super.key,
    required this.apiClient,
    required this.authPort,
  });

  final ApiClient apiClient;
  final GoogleAuthPort authPort;

  @override
  State<SystemSettingsScreen> createState() => _SystemSettingsScreenState();
}

class _SystemSettingsScreenState extends State<SystemSettingsScreen> {
  bool _notificationsEnabled = true;
  bool _signingOut = false;

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
            onChanged: (value) => setState(() => _notificationsEnabled = value),
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
              'OIKONOMOS $kAppVersion',
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
