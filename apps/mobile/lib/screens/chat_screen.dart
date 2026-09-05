import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';
import '../realtime/sse_client.dart';
import '../widgets/avatar.dart';

/// TASK-147 (Mobile Wave 1b) — message history + live updates for one
/// bot's thread. Mirrors `apps/dashboard/src/pages/ChatPage.tsx`: an
/// initial `GET /threads/:id/messages` fetch, then a held-open SSE
/// subscription (TASK-144's `subscribeToThreadMessages`) for everything
/// that arrives after — no polling. In this navigation model "switching
/// threads/leaving the screen" is always a pop/push of this screen, so
/// [dispose] tearing the subscription down covers both cases; the
/// subscription is never left dangling past this widget's lifetime.
class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.apiClient, required this.bot});

  final ApiClient apiClient;
  final SingleThread bot;

  @override
  State<ChatScreen> createState() => ChatScreenState();
}

class ChatScreenState extends State<ChatScreen>
    with SingleTickerProviderStateMixin {
  final _composeController = TextEditingController();
  final List<ThreadMessage> _messages = [];
  final Set<String> _seenMessageIds = {};
  bool _loading = true;
  bool _sending = false;
  String? _error;
  SseSubscription? _subscription;
  late final TabController _tabController;
  List<Routine>? _routines;
  String? _routinesError;
  bool _loadingRoutines = false;
  final Map<String, String> _approvalStatuses = {};
  final Set<String> _decidingApprovals = {};

  /// Exposed for tests: true once the SSE subscription has been opened
  /// (and not yet closed) for this screen instance.
  bool get hasOpenSubscription => _subscription != null;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this)
      ..addListener(_onTabChanged);
    _load();
  }

  @override
  void dispose() {
    _subscription?.close();
    _subscription = null;
    _tabController
      ..removeListener(_onTabChanged)
      ..dispose();
    _composeController.dispose();
    super.dispose();
  }

  void _onTabChanged() {
    if (_tabController.index == 1 && !_tabController.indexIsChanging) {
      _loadRoutines();
    }
  }

  Future<void> _loadRoutines() async {
    if (_loadingRoutines || _routines != null) return;
    setState(() {
      _loadingRoutines = true;
      _routinesError = null;
    });
    try {
      final routines = await widget.apiClient.listRoutines(widget.bot.roleId);
      if (!mounted) return;
      setState(() => _routines = routines);
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (mounted) setState(() => _routinesError = 'Could not load routines.');
    } finally {
      if (mounted) setState(() => _loadingRoutines = false);
    }
  }

  Future<void> _decideApproval(ThreadMessage message, String decision) async {
    final approval = message.approval!;
    if (_decidingApprovals.contains(message.id)) return;
    setState(() => _decidingApprovals.add(message.id));
    try {
      final decided = await widget.apiClient.decideApproval(
        approval.nonce,
        decision,
      );
      if (!mounted) return;
      setState(() {
        _approvalStatuses[message.id] = decided
            ? (decision == 'granted' ? 'approved' : 'denied')
            : 'Already decided or no longer valid.';
      });
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to decide approval.')),
        );
      }
    } finally {
      if (mounted) setState(() => _decidingApprovals.remove(message.id));
    }
  }

  void _addMessage(ThreadMessage message) {
    if (!_seenMessageIds.add(message.id)) return;
    if (!mounted) return;
    setState(() => _messages.add(message));
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final messages = await widget.apiClient.listThreadMessages(widget.bot.id);
      if (!mounted) return;
      setState(() {
        _messages
          ..clear()
          ..addAll(messages);
        _seenMessageIds
          ..clear()
          ..addAll(messages.map((m) => m.id));
        _loading = false;
      });
      _subscription = subscribeToThreadMessages(
        baseUrl: widget.apiClient.baseUrl,
        threadId: widget.bot.id,
        onMessage: _addMessage,
        authHeaders: () => widget.apiClient.cookieHeaders,
        httpClient: widget.apiClient.httpClient,
      );
    } on UnauthorizedError {
      if (!mounted) return;
      Navigator.of(context).pop();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not load messages.';
        _loading = false;
      });
    }
  }

  Future<void> _send() async {
    final body = _composeController.text.trim();
    if (body.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      final sent = await widget.apiClient.sendThreadMessage(
        widget.bot.id,
        body,
      );
      _addMessage(sent);
      _composeController.clear();
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Failed to send message.')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            BotAvatar(
              seed: widget.bot.avatarSeed,
              name: widget.bot.botName,
              size: 28,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(widget.bot.botName, overflow: TextOverflow.ellipsis),
            ),
          ],
        ),
        actions: [
          IconButton(
            key: const Key('bot-settings-button'),
            icon: const Icon(Icons.settings_outlined),
            tooltip: 'Bot settings',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => _SettingsScreen(
                  apiClient: widget.apiClient,
                  bot: widget.bot,
                ),
              ),
            ),
          ),
        ],
        bottom: TabBar(
          controller: _tabController,
          tabs: const [
            Tab(text: 'Chat'),
            Tab(text: 'Routines'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          Column(
            children: [
              Expanded(child: _buildBody()),
              _buildComposeBox(),
            ],
          ),
          _buildRoutines(),
        ],
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(child: Text(_error!, key: const Key('chat-error')));
    }
    if (_messages.isEmpty) {
      return const Center(
        key: Key('chat-empty'),
        child: Text('No messages yet — say hello.'),
      );
    }
    return ListView.builder(
      key: const Key('message-list'),
      padding: const EdgeInsets.all(12),
      itemCount: _messages.length,
      itemBuilder: (context, index) {
        final message = _messages[index];
        if (message.role == 'system') {
          return _SystemEventLine(message: message);
        }
        final isUser = message.role == 'user';
        return Align(
          alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            key: Key('message-${message.id}'),
            margin: const EdgeInsets.symmetric(vertical: 4),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            constraints: BoxConstraints(
              maxWidth: MediaQuery.of(context).size.width * 0.75,
            ),
            decoration: BoxDecoration(
              color: isUser
                  ? Theme.of(context).colorScheme.primary
                  : Theme.of(context).colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                isUser
                    ? Text(
                        message.body,
                        style: const TextStyle(color: Colors.white),
                      )
                    : MarkdownBody(
                        key: Key('message-body-${message.id}'),
                        data: message.body,
                        shrinkWrap: true,
                        selectable: false,
                        styleSheet: MarkdownStyleSheet.fromTheme(
                          Theme.of(context),
                        ).copyWith(
                          p: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ),
                if (message.approval != null) ...[
                  const SizedBox(height: 8),
                  _ApprovalCard(
                    message: message,
                    status: _approvalStatuses[message.id] ??
                        message.approval!.status,
                    deciding: _decidingApprovals.contains(message.id),
                    onDecide: (decision) => _decideApproval(message, decision),
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildComposeBox() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                key: const Key('compose-field'),
                controller: _composeController,
                decoration: InputDecoration(
                  hintText: 'Ask ${widget.bot.botName}',
                ),
                onSubmitted: (_) => _send(),
              ),
            ),
            IconButton(
              key: const Key('send-button'),
              icon: const Icon(Icons.send),
              onPressed: _sending ? null : _send,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRoutines() {
    if (_loadingRoutines) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_routinesError != null) {
      return Center(
        child: Text(_routinesError!, key: const Key('routines-error')),
      );
    }
    if (_routines == null || _routines!.isEmpty) {
      return const Center(
        key: Key('routines-empty'),
        child: Text('No routines configured for this bot.'),
      );
    }
    return ListView.builder(
      key: const Key('routines-list'),
      itemCount: _routines!.length,
      itemBuilder: (context, index) {
        final routine = _routines![index];
        return ListTile(
          title: Text(routine.name),
          subtitle: Text(
            'Schedule: ${routine.schedule ?? 'Not scheduled'}\n'
            'Last: ${routine.lastFireAt ?? 'Never'} · Next: ${routine.nextFireAt ?? 'Not scheduled'}',
          ),
          isThreeLine: true,
        );
      },
    );
  }
}

class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({
    required this.message,
    required this.status,
    required this.deciding,
    required this.onDecide,
  });

  final ThreadMessage message;
  final String status;
  final bool deciding;
  final ValueChanged<String> onDecide;

  @override
  Widget build(BuildContext context) {
    final approval = message.approval!;
    final pending = status == 'pending';
    return Card(
      key: Key('approval-card-${message.id}'),
      color: Theme.of(context).colorScheme.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Approval needed',
              style: TextStyle(fontWeight: FontWeight.bold),
            ),
            Text('Capability: ${approval.capabilityId}'),
            Text(approval.actionRender),
            Text('Status: $status'),
            if (pending)
              Row(
                children: [
                  TextButton(
                    onPressed: deciding ? null : () => onDecide('granted'),
                    child: const Text('Approve'),
                  ),
                  TextButton(
                    onPressed: deciding ? null : () => onDecide('rejected'),
                    child: const Text('Deny'),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

/// TASK-157 (4) — small, centered, muted, icon-prefixed line for a
/// `role: 'system'` message (e.g. "Renamed to X"), visually distinct from a
/// normal chat bubble. `system` is already a real value of the server's
/// `MessageRole` enum (`packages/db/src/messages.ts`); no endpoint emits it
/// yet, but this is surfacing an existing wire convention, not inventing
/// one, so the client is ready the moment one does.
class _SystemEventLine extends StatelessWidget {
  const _SystemEventLine({required this.message});

  final ThreadMessage message;

  @override
  Widget build(BuildContext context) {
    final mutedColor = Theme.of(context).colorScheme.onSurfaceVariant;
    return Padding(
      key: Key('message-${message.id}'),
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.info_outline, size: 14, color: mutedColor),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              message.body,
              textAlign: TextAlign.center,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: mutedColor),
            ),
          ),
        ],
      ),
    );
  }
}

class _SettingsScreen extends StatefulWidget {
  const _SettingsScreen({required this.apiClient, required this.bot});

  final ApiClient apiClient;
  final SingleThread bot;

  @override
  State<_SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<_SettingsScreen> {
  bool _loadingTitle = true;
  String? _title;
  String? _titleError;

  @override
  void initState() {
    super.initState();
    _loadTitle();
  }

  /// TASK-157 (4) — `roles.title` is a real column (confirmed against the
  /// live schema) but `GET /roles` doesn't serialize it yet
  /// (`services/control-api/src/app.ts`'s `serializeRole`, outside this
  /// task's `apps/mobile/**` territory to fix) and there is no `PATCH
  /// /roles/:roleId` route to write it either. Per the task's own scoping
  /// instruction ("read-only display if no update route exists yet"), this
  /// fetches the role and shows whatever title comes back (`null` today)
  /// read-only, rather than inventing a write path that doesn't exist.
  Future<void> _loadTitle() async {
    try {
      final roles = await widget.apiClient.listRoles();
      Role? match;
      for (final role in roles) {
        if (role.id == widget.bot.roleId) {
          match = role;
          break;
        }
      }
      if (!mounted) return;
      setState(() {
        _title = match?.title;
        _loadingTitle = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _titleError = 'Could not load title.';
        _loadingTitle = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('${widget.bot.botName} settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Auto-review',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          const Text(
            'Require approval for risky shell, MCP, and computer actions.',
          ),
          const SizedBox(height: 20),
          const Text(
            'Title (optional)',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          if (_loadingTitle)
            const SizedBox(
              key: Key('title-loading'),
              height: 20,
              width: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            TextField(
              key: const Key('title-field'),
              readOnly: true,
              controller: TextEditingController(text: _title ?? ''),
              decoration: InputDecoration(
                hintText: 'No title set',
                helperText: _titleError ??
                    'Read-only — no update endpoint exists for this yet.',
              ),
            ),
          const SizedBox(height: 20),
          const Text(
            'App info',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          const Text('OIKONOMOS mobile'),
        ],
      ),
    );
  }
}
