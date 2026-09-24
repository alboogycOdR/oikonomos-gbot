import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';
import '../push/device_platform.dart';
import '../push/noop_push_port.dart';
import '../push/notification_preference.dart';
import '../push/push_message.dart';
import '../push/push_port.dart';
import '../push/push_registrar.dart';
import '../widgets/avatar.dart';
import 'chat_screen.dart';
import 'create_bot_screen.dart';
import 'login_screen.dart';
import 'projects_screen.dart';
import 'settings_screen.dart';

/// TASK-147 (Mobile Wave 1b) — bot roster, the landing screen after login.
/// Mirrors `apps/dashboard/src/components/chat/BotSidebar.tsx` /
/// `ChatPage.tsx`'s `toBotSummary`: v1 is one thread per bot, so the
/// roster is `GET /threads` filtered to single-role threads
/// ([SingleThread]). Group threads ([GroupThread]) are deliberately
/// excluded here — the group-chat screen is out of scope for this task
/// (WORKFLOW_MOBILE_W1_W2_2026-09-04.md's deferred list) rather than
/// rendered with a shape this screen doesn't understand.
class RosterScreen extends StatefulWidget {
  const RosterScreen({
    super.key,
    required this.apiClient,
    this.pushPort = const NoopPushPort(),
    this.notificationPreference = const NotificationPreference(),
    this.authPort,
  });

  final ApiClient apiClient;

  /// TASK-149 (Mobile Wave 2b) — defaults to the dormant [NoopPushPort] so
  /// every prior test of this screen (constructed without a `pushPort`
  /// argument) is unaffected: registration never fires and no additional
  /// HTTP request is ever queued/expected.
  final PushPort pushPort;

  /// TASK-232 — persisted opt-out gate checked before the initial
  /// registration and updated live from the system settings screen.
  /// Defaults to the real `shared_preferences`-backed implementation;
  /// tests inject a fake.
  final NotificationPreference notificationPreference;

  /// TASK-174 — real Google/Firebase sign-out port used by the sign-out
  /// action below. `RosterScreen` does not hold a reference to the port
  /// `LoginScreen` used to sign in — `LoginScreen`'s own default port is a
  /// private (`_DefaultAuthPort`) implementation detail of that file, and
  /// no shared session/DI surface exists in this task's `Owned_Paths` to
  /// thread the *same instance* through. A fresh default
  /// [FirebaseGoogleAuthPort] is constructed lazily here (via
  /// [_defaultAuthPort]) when none is supplied. This is safe: both
  /// `signIn` and `signOut` ultimately delegate to the same underlying
  /// `GoogleSignIn.instance`/`FirebaseAuth.instance` singletons, so a
  /// second port instance still signs out of the one real session. Tests
  /// inject a fake here instead, exactly as `LoginScreen` does.
  final GoogleAuthPort? authPort;

  /// Indirection so a real [FirebaseGoogleAuthPort] (not `const`
  /// -constructible) is never eagerly built by the widget's constant
  /// default argument list — only the first time a sign-out is actually
  /// requested without an injected [authPort].
  static FirebaseGoogleAuthPort? _sharedDefaultAuthPort;

  GoogleAuthPort _resolvedAuthPort() =>
      authPort ?? (_sharedDefaultAuthPort ??= FirebaseGoogleAuthPort());

  @override
  State<RosterScreen> createState() => _RosterScreenState();
}

class _RosterScreenState extends State<RosterScreen> {
  List<SingleThread> _bots = [];
  bool _loading = true;
  String? _error;
  late final PushRegistrar _pushRegistrar;

  @override
  void initState() {
    super.initState();
    _pushRegistrar = PushRegistrar(
      apiClient: widget.apiClient,
      port: widget.pushPort,
      devicePlatform: currentDevicePlatform,
      onMessage: _showPushMessage,
    );
    _initPushIfEnabled();
    _load();
  }

  /// TASK-232 — only registers for push if the persisted preference
  /// allows it. Checked at startup; [setNotificationsEnabled] below is
  /// the live-toggle counterpart called from the system settings screen.
  Future<void> _initPushIfEnabled() async {
    final enabled = await widget.notificationPreference.isEnabled();
    if (enabled) {
      await _pushRegistrar.initialize();
    }
  }

  /// TASK-232 — live counterpart to the startup gate above: turning
  /// notifications off immediately stops this session's foreground
  /// message handling and future token registration; turning them back
  /// on re-initializes registration without needing an app restart.
  Future<void> setNotificationsEnabled(bool enabled) async {
    await widget.notificationPreference.setEnabled(enabled);
    if (enabled) {
      await _pushRegistrar.initialize();
    } else {
      _pushRegistrar.dispose();
    }
  }

  @override
  void dispose() {
    _pushRegistrar.dispose();
    super.dispose();
  }

  /// TASK-149 (Mobile Wave 2b) — foreground display for the two backend
  /// triggers (approval created, run completed). A `null` decode result
  /// (unrecognized payload shape) is silently dropped rather than shown.
  void _showPushMessage(PushMessage message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        key: const Key('push-notification-snackbar'),
        content: Text(message.displayText),
      ),
    );
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final threads = await widget.apiClient.listThreads();
      final bots = threads.whereType<SingleThread>().toList()
        ..sort(_compareBots);
      if (!mounted) return;
      setState(() {
        _bots = bots;
        _loading = false;
      });
    } on UnauthorizedError {
      if (!mounted) return;
      await Navigator.of(context).pushAndRemoveUntil(
        MaterialPageRoute(
          builder: (_) => LoginScreen(apiClient: widget.apiClient),
        ),
        (route) => false,
      );
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not load bots.';
        _loading = false;
      });
    }
  }

  int _compareBots(SingleThread a, SingleThread b) {
    final pinned = (b.pinnedAt != null ? 1 : 0).compareTo(
      a.pinnedAt != null ? 1 : 0,
    );
    if (pinned != 0) return pinned;
    if (a.pinnedAt != null && b.pinnedAt != null) {
      final pinTime = b.pinnedAt!.compareTo(a.pinnedAt!);
      if (pinTime != 0) return pinTime;
    }
    return b.updatedAt.compareTo(a.updatedAt);
  }

  String _formatRelative(String iso) {
    final then = DateTime.tryParse(iso);
    if (then == null) return '';
    final diffMinutes = DateTime.now().difference(then).inMinutes;
    if (diffMinutes < 1) return 'just now';
    if (diffMinutes < 60) return '${diffMinutes}m';
    final diffHours = diffMinutes ~/ 60;
    if (diffHours < 24) return '${diffHours}h';
    return '${diffHours ~/ 24}d';
  }

  Future<void> _openCreateBot() async {
    final created = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => CreateBotScreen(apiClient: widget.apiClient),
      ),
    );
    if (created == true) {
      await _load();
    }
  }

  void _openProjects() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ProjectsScreen(apiClient: widget.apiClient),
      ),
    );
  }

  void _openChat(SingleThread bot) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ChatScreen(
          apiClient: widget.apiClient,
          bot: bot,
          markReadOnOpen: true,
        ),
      ),
    );
  }

  Future<void> _togglePin(SingleThread bot) async {
    try {
      if (bot.pinnedAt == null) {
        await widget.apiClient.pinThread(bot.id);
      } else {
        await widget.apiClient.unpinThread(bot.id);
      }
      await _load();
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not update thread pin.')),
      );
    }
  }

  /// Opens the system-wide settings screen (profile, sign out,
  /// notifications, version). Sign-out used to be a bare logout icon in
  /// this AppBar; it now lives inside that screen behind a proper
  /// profile header, as a settings screen is where users look for it.
  void _openSettings() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SystemSettingsScreen(
          apiClient: widget.apiClient,
          authPort: widget._resolvedAuthPort(),
          notificationPreference: widget.notificationPreference,
          onNotificationsChanged: setNotificationsEnabled,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('OIKONOMOS'),
        actions: [
          IconButton(
            key: const Key('new-bot-button'),
            icon: const Icon(Icons.add),
            tooltip: 'New bot',
            onPressed: _openCreateBot,
          ),
          IconButton(
            key: const Key('projects-button'),
            icon: const Icon(Icons.folder_outlined),
            tooltip: 'Projects',
            onPressed: _openProjects,
          ),
          IconButton(
            key: const Key('settings-button'),
            icon: const Icon(Icons.settings_outlined),
            tooltip: 'Settings',
            onPressed: _openSettings,
          ),
        ],
      ),
      body: RefreshIndicator(onRefresh: _load, child: _buildBody()),
    );
  }

  Widget _buildBody() {
    if (_loading && _bots.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return ListView(
        children: [
          const SizedBox(height: 80),
          Center(child: Text(_error!, key: const Key('roster-error'))),
        ],
      );
    }
    if (_bots.isEmpty) {
      return ListView(
        children: const [
          SizedBox(height: 80),
          Center(
            key: Key('roster-empty'),
            child: Text('No bots yet — create one to start chatting.'),
          ),
        ],
      );
    }
    return ListView.builder(
      key: const Key('roster-list'),
      itemCount: _bots.length,
      itemBuilder: (context, index) {
        final bot = _bots[index];
        return ListTile(
          key: Key('bot-tile-${bot.id}'),
          leading: BotAvatar(seed: bot.avatarSeed, name: bot.botName),
          title: Text(
            (bot.title != null && bot.title!.trim().isNotEmpty)
                ? bot.title!
                : bot.botName,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: bot.displayPreview.isEmpty
              ? null
              : Text(
                  bot.displayPreview,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (bot.unreadCount > 0)
                Container(
                  key: Key('unread-badge-${bot.id}'),
                  margin: const EdgeInsets.only(right: 8),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.primary,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    '${bot.unreadCount}',
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onPrimary,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              Text(_formatRelative(bot.displayTime)),
            ],
          ),
          onTap: () => _openChat(bot),
          onLongPress: () => _togglePin(bot),
        );
      },
    );
  }
}
