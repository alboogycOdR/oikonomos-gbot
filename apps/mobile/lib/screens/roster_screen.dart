import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

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
/// roster is `GET /threads` filtered to single-role threads ([SingleThread])
/// plus TASK-357's read-only `bot_pair` entries. Ordinary [GroupThread] rows
/// remain excluded, preserving the legacy fallback for older servers.
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
  List<ThreadSummary> _bots = [];
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
      final bots = threads
          .where((thread) =>
              thread is SingleThread ||
              (thread is GroupThread && thread.isBotPair))
          .toList()
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

  int _compareBots(ThreadSummary a, ThreadSummary b) {
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

  Future<void> _openChat(SingleThread bot) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ChatScreen(
          apiClient: widget.apiClient,
          bot: bot,
          markReadOnOpen: true,
        ),
      ),
    );
    if (mounted) await _load();
  }

  void _openBotPairTranscript(GroupThread pair) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _BotPairTranscriptScreen(
          apiClient: widget.apiClient,
          pair: pair,
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
        final pair = bot is GroupThread ? bot : null;
        final single = bot is SingleThread ? bot : null;
        final isPair = pair != null;
        return ListTile(
          key: Key('bot-tile-${bot.id}'),
          leading: isPair
              ? _PairAvatar(pair: pair)
              : BotAvatar(
                  seed: single!.avatarSeed,
                  name: single.botName,
                  avatarColor: single.avatarColor,
                  avatarShape: single.avatarShape,
                ),
          title: Text(
            (bot.title != null && bot.title!.trim().isNotEmpty)
                ? bot.title!
                : isPair
                    ? pair.memberNames.join(' and ')
                    : single!.botName,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: bot.displayPreview.isEmpty
              ? null
              : Row(
                  children: [
                    if (bot.previewAuthorKind == 'bot_outbound')
                      const Icon(
                        Icons.north_east,
                        key: Key('bot-outbound-preview-icon'),
                        size: 16,
                        semanticLabel: 'Outbound message',
                      ),
                    if (bot.previewAuthorKind == 'bot_outbound')
                      const SizedBox(width: 4),
                    Expanded(
                      child: Text(
                        bot.displayPreview,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
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
              if (!isPair && bot.pinnedAt != null)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: Icon(
                    Icons.push_pin,
                    key: Key('pin-indicator-${bot.id}'),
                    size: 18,
                    semanticLabel: 'Pinned',
                  ),
                ),
              Text(_formatRelative(bot.displayTime)),
            ],
          ),
          onTap: () =>
              isPair ? _openBotPairTranscript(pair) : _openChat(single!),
          onLongPress: isPair ? null : () => _togglePin(single!),
        );
      },
    );
  }
}

/// Two compact, deliberately overlapping avatars identify a synthetic
/// bot-to-bot row without introducing a new avatar asset or server field.
class _PairAvatar extends StatelessWidget {
  const _PairAvatar({required this.pair});

  final GroupThread pair;

  @override
  Widget build(BuildContext context) {
    final names = pair.memberNames;
    final ids = pair.memberRoleIds;
    return SizedBox(
      key: Key('bot-pair-avatar-${pair.id}'),
      width: 52,
      height: 40,
      child: Stack(
        children: [
          if (names.isNotEmpty)
            Positioned(
              left: 0,
              child: BotAvatar(
                seed: ids.isNotEmpty ? ids.first : names.first,
                name: names.first,
                size: 32,
              ),
            ),
          if (names.length > 1)
            Positioned(
              right: 0,
              top: 8,
              child: BotAvatar(
                seed: ids.length > 1 ? ids[1] : names[1],
                name: names[1],
                size: 32,
              ),
            ),
        ],
      ),
    );
  }
}

/// Read-only view of the mailbox traffic which produced a `bot_pair` row.
/// It intentionally fetches one member's handoffs and filters to the pair:
/// the role-message route returns both inbound and outbound traffic, while a
/// synthetic pair id has no thread route and must never expose a composer.
class _BotPairTranscriptScreen extends StatefulWidget {
  const _BotPairTranscriptScreen({required this.apiClient, required this.pair});

  final ApiClient apiClient;
  final GroupThread pair;

  @override
  State<_BotPairTranscriptScreen> createState() =>
      _BotPairTranscriptScreenState();
}

class _BotPairTranscriptScreenState extends State<_BotPairTranscriptScreen> {
  List<RoleHandoff>? _handoffs;
  Map<String, String> _roleNames = const {};
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (widget.pair.memberRoleIds.isEmpty) {
      setState(() => _handoffs = const []);
      return;
    }
    try {
      final members = widget.pair.memberRoleIds.toSet();
      final handoffs = await widget.apiClient
          .listRoleHandoffs(widget.pair.memberRoleIds.first);
      // `memberNames` is a display list, not an id-to-name map: the API sorts
      // names for a stable title independently of ids. Resolve sender labels
      // from roles where available instead of pairing those two lists by index.
      Map<String, String> roleNames = const {};
      try {
        final roles = await widget.apiClient.listRoles();
        roleNames = {for (final role in roles) role.id: role.name};
      } catch (_) {
        // The transcript is still useful with role-id sender fallbacks.
      }
      if (!mounted) return;
      setState(() {
        _roleNames = roleNames;
        _handoffs = handoffs
            .where((handoff) =>
                members.contains(handoff.fromRoleId) &&
                members.contains(handoff.toRoleId))
            .toList()
          ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
      });
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load messages.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final title = widget.pair.title?.trim().isNotEmpty == true
        ? widget.pair.title!
        : widget.pair.memberNames.join(' and ');
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: _error != null
          ? Center(child: Text(_error!, key: const Key('bot-pair-error')))
          : _handoffs == null
              ? const Center(child: CircularProgressIndicator())
              : _handoffs!.isEmpty
                  ? const Center(
                      key: Key('bot-pair-empty'),
                      child: Text('No messages yet.'),
                    )
                  : ListView.builder(
                      key: const Key('bot-pair-message-list'),
                      padding: const EdgeInsets.all(12),
                      itemCount: _handoffs!.length,
                      itemBuilder: (context, index) => _PairMessageBubble(
                        handoff: _handoffs![index],
                        senderName: _nameFor(_handoffs![index].fromRoleId),
                      ),
                    ),
    );
  }

  String _nameFor(String roleId) {
    return _roleNames[roleId] ?? roleId;
  }
}

/// Mirrors ChatScreen's left-aligned bot bubble treatment, but has no action
/// controls: bot-pair transcripts are observational and therefore read-only.
class _PairMessageBubble extends StatelessWidget {
  const _PairMessageBubble({required this.handoff, required this.senderName});

  final RoleHandoff handoff;
  final String senderName;

  @override
  Widget build(BuildContext context) => Align(
        alignment: Alignment.centerLeft,
        child: Container(
          key: Key('bot-pair-message-${handoff.id}'),
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          constraints: BoxConstraints(
            maxWidth: MediaQuery.of(context).size.width * 0.75,
          ),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(senderName, style: Theme.of(context).textTheme.labelMedium),
              const SizedBox(height: 4),
              MarkdownBody(
                key: Key('bot-pair-message-body-${handoff.id}'),
                data: handoff.body,
                shrinkWrap: true,
                selectable: false,
                styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context))
                    .copyWith(p: Theme.of(context).textTheme.bodyMedium),
              ),
            ],
          ),
        ),
      );
}
