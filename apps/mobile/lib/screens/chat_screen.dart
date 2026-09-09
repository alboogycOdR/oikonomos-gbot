import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';
import '../attach/channel_file_picker.dart';
import '../attach/file_picker_port.dart';
import '../realtime/sse_client.dart';
import '../widgets/avatar.dart';
import '../widgets/context_meter.dart';
import '../widgets/live_agent_button.dart';
import '../widgets/secret_request_card.dart';
import '../widgets/skill_picker.dart';
import 'create_routine_screen.dart';
import 'routine_detail_screen.dart';
import 'skills_screen.dart';

/// TASK-147 (Mobile Wave 1b) — message history + live updates for one
/// bot's thread. Mirrors `apps/dashboard/src/pages/ChatPage.tsx`: an
/// initial `GET /threads/:id/messages` fetch, then a held-open SSE
/// subscription (TASK-144's `subscribeToThreadMessages`) for everything
/// that arrives after — no polling. In this navigation model "switching
/// threads/leaving the screen" is always a pop/push of this screen, so
/// [dispose] tearing the subscription down covers both cases; the
/// subscription is never left dangling past this widget's lifetime.
class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    required this.apiClient,
    required this.bot,
    this.filePicker = const ChannelFilePicker(),
  });

  final ApiClient apiClient;
  final SingleThread bot;
  final FilePickerPort filePicker;

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
  List<RoleHandoff> _handoffs = const [];
  Map<String, Role> _rolesById = const {};
  final Map<String, String> _approvalStatuses = {};
  final Set<String> _decidingApprovals = {};
  final Map<String, String> _secretRequestStatuses = {};
  final Set<String> _decidingSecretRequests = {};
  final List<MessageAttachment> _pendingAttachments = [];
  bool _uploading = false;
  String? _uploadError;
  bool _skillPickerOpen = false;

  /// Exposed for tests: true once the SSE subscription has been opened
  /// (and not yet closed) for this screen instance.
  bool get hasOpenSubscription => _subscription != null;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this)
      ..addListener(_onTabChanged);
    _load();
    _loadHandoffs();
  }

  Future<void> _confirmStartFresh() async {
    final confirmed = await showModalBottomSheet<bool>(
      context: context,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Start fresh?',
                  style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 12),
              const Text(
                  'Earlier turns stay visible, but the bot will not see them in the new context.'),
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('start-fresh-confirm'),
                onPressed: () => Navigator.of(context).pop(true),
                child: const Text('Start fresh'),
              ),
            ],
          ),
        ),
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    try {
      // The result itself no longer needs to be held here — the context
      // meter this fed lives on the settings screen now (see
      // _SettingsScreen), which re-fetches its own copy on open.
      await widget.apiClient.startFresh(widget.bot.id);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not start a fresh context.')));
      }
    }
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
    if (!_tabController.indexIsChanging) {
      setState(() {}); // rebuilds the FAB visibility for the new tab
      if (_tabController.index == 1) {
        _loadRoutines();
      }
    }
  }

  /// [force] re-fetches even if routines were already loaded — used after
  /// a successful creation so the tab reflects the new routine without the
  /// user leaving and re-entering the screen.
  Future<void> _loadRoutines({bool force = false}) async {
    if (_loadingRoutines || (_routines != null && !force)) return;
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

  Future<void> _openCreateRoutine() async {
    final created = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => CreateRoutineScreen(
          apiClient: widget.apiClient,
          roleId: widget.bot.roleId,
        ),
      ),
    );
    if (created == true) {
      await _loadRoutines(force: true);
    }
  }

  Future<void> _openRoutineDetail(Routine routine) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => RoutineDetailScreen(
          apiClient: widget.apiClient,
          routine: routine,
        ),
      ),
    );
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

  /// TASK-187 (G-05b) — `value` is handed straight to the API client and
  /// never stored on this state object; only the server's returned ref (or
  /// a "no longer valid" message) is retained, for the same reason
  /// [SecretRequestCard] itself never lets it escape past this callback.
  Future<void> _provideSecret(ThreadMessage message, String value) async {
    if (_decidingSecretRequests.contains(message.id)) return;
    setState(() => _decidingSecretRequests.add(message.id));
    try {
      final ref = await widget.apiClient.fulfilSecretRequest(
        message.secretRequest!.requestId,
        value,
      );
      if (!mounted) return;
      setState(() {
        _secretRequestStatuses[message.id] = ref == null
            ? 'Already decided or no longer valid.'
            : 'Provided · ${ref.startsWith('secret://') ? ref : 'secret://$ref'}';
      });
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to provide secret.')),
        );
      }
    } finally {
      if (mounted) setState(() => _decidingSecretRequests.remove(message.id));
    }
  }

  Future<void> _declineSecret(ThreadMessage message) async {
    if (_decidingSecretRequests.contains(message.id)) return;
    setState(() => _decidingSecretRequests.add(message.id));
    try {
      final declined = await widget.apiClient.declineSecretRequest(
        message.secretRequest!.requestId,
      );
      if (!mounted) return;
      setState(() {
        _secretRequestStatuses[message.id] = declined
            ? 'Declined'
            : 'Already decided or no longer valid.';
      });
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to decline secret request.')),
        );
      }
    } finally {
      if (mounted) setState(() => _decidingSecretRequests.remove(message.id));
    }
  }

  Future<void> _openSkillPicker() async {
    if (_skillPickerOpen) return;
    setState(() => _skillPickerOpen = true);
    final skill = await showModalBottomSheet<Skill>(
      context: context,
      isScrollControlled: true,
      builder: (_) => SkillPicker(
        apiClient: widget.apiClient,
        roleId: widget.bot.roleId,
      ),
    );
    if (!mounted) return;
    setState(() => _skillPickerOpen = false);
    if (skill != null) {
      _composeController.text = '/${skill.name} ';
      _composeController.selection = TextSelection.collapsed(
        offset: _composeController.text.length,
      );
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

  /// Handoffs are optional timeline decoration: a failure must not hide chat.
  Future<void> _loadHandoffs() async {
    try {
      final handoffs =
          await widget.apiClient.listRoleHandoffs(widget.bot.roleId);
      if (!mounted) return;
      // Most timelines have no role-to-role traffic. Avoid a second request
      // unless there is a chip that needs the other role's display details.
      if (handoffs.isEmpty) {
        setState(() => _handoffs = handoffs);
        return;
      }
      final roles = await widget.apiClient.listRoles();
      if (!mounted) return;
      setState(() {
        _handoffs = handoffs;
        _rolesById = {for (final role in roles) role.id: role};
      });
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      // This inline enhancement intentionally remains absent on failure.
    }
  }

  void _showHandoff(RoleHandoff handoff, String otherName) {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Handoff with $otherName'),
        content: SingleChildScrollView(child: Text(handoff.body)),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Close'))
        ],
      ),
    );
  }

  Future<void> _attach() async {
    if (_uploading || _sending) return;
    setState(() {
      _uploadError = null;
    });
    PickedAttachment? picked;
    try {
      picked = await widget.filePicker.pick();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _uploadError = 'Could not open the file picker.';
      });
      return;
    }
    if (picked == null || !mounted) return;
    setState(() => _uploading = true);
    try {
      final uploaded = await widget.apiClient.uploadThreadAttachment(
        widget.bot.id,
        filename: picked.filename,
        contentType: picked.contentType,
        bytes: picked.bytes,
      );
      if (!mounted) return;
      setState(() {
        _pendingAttachments.add(uploaded);
        _uploading = false;
      });
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _uploading = false;
        _uploadError = error.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _uploading = false;
        _uploadError = 'Failed to upload attachment.';
      });
    }
  }

  Future<void> _send() async {
    final body = _composeController.text.trim();
    if ((body.isEmpty && _pendingAttachments.isEmpty) ||
        _sending ||
        _uploading) {
      return;
    }
    setState(() => _sending = true);
    try {
      final sent = await widget.apiClient.sendThreadMessage(
        widget.bot.id,
        body,
        attachmentIds: _pendingAttachments.map((item) => item.id).toList(),
      );
      _addMessage(sent);
      _composeController.clear();
      _pendingAttachments.clear();
      _uploadError = null;
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
        // TASK-168: frosted/floating header — a translucent background with
        // a backdrop blur over whatever has scrolled beneath it, rather than
        // a solid opaque bar. `flexibleSpace` + BackdropFilter is the
        // standard Flutter approach for this effect.
        backgroundColor:
            Theme.of(context).colorScheme.surface.withValues(alpha: 0.72),
        elevation: 0,
        scrolledUnderElevation: 0,
        flexibleSpace: ClipRect(
          child: BackdropFilter(
            key: const Key('chat-header-frost'),
            filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
            child: const SizedBox.expand(),
          ),
        ),
        // The context meter used to live here, squeezed between the avatar
        // and the action icons — on a real phone width that left so little
        // room for the bot's own name that it collapsed to an ellipsis.
        // Moved to the settings screen (see _SettingsScreen), which has a
        // full-width row to give it, rather than fighting a header that
        // was never going to have enough space for both.
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
          PopupMenuButton<String>(
            key: const Key('chat-overflow-menu'),
            onSelected: (value) {
              if (value == 'fresh') {
                _confirmStartFresh();
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'fresh', child: Text('Start fresh')),
            ],
          ),
          LiveAgentButton(
            apiClient: widget.apiClient,
            roleId: widget.bot.roleId,
          ),
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
      floatingActionButton: _tabController.index == 1
          ? FloatingActionButton(
              key: const Key('create-routine-fab'),
              onPressed: _openCreateRoutine,
              child: const Icon(Icons.add),
            )
          : null,
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(child: Text(_error!, key: const Key('chat-error')));
    }
    if (_messages.isEmpty && _handoffs.isEmpty) {
      return const Center(
        key: Key('chat-empty'),
        child: Text('No messages yet — say hello.'),
      );
    }
    return Column(
      children: [
        if (_handoffs.isNotEmpty)
          SizedBox(
            height: 56,
            child: ListView.builder(
              key: const Key('handoff-chip-list'),
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              itemCount: _handoffs.length,
              itemBuilder: (context, index) {
                final handoff = _handoffs[index];
                final otherId = handoff.fromRoleId == widget.bot.roleId
                    ? handoff.toRoleId
                    : handoff.fromRoleId;
                final other = _rolesById[otherId];
                return _HandoffChip(
                  handoff: handoff,
                  otherName: other?.name ?? otherId,
                  avatarSeed: other?.avatarSeed ?? otherId,
                  onTap: () => _showHandoff(handoff, other?.name ?? otherId),
                );
              },
            ),
          ),
        Expanded(
            child: ListView.builder(
          key: const Key('message-list'),
          padding: const EdgeInsets.all(12),
          itemCount: _messages.length,
          itemBuilder: (context, index) {
            final message = _messages[index];
            final showDateDivider = index == 0 ||
                !_isSameDay(_messages[index - 1].createdAt, message.createdAt);
            final bubble = _buildMessageBubble(context, message);
            if (!showDateDivider) return bubble;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _DateDivider(
                  key: Key('date-divider-${message.id}'),
                  label: _dateDividerLabel(message.createdAt),
                ),
                bubble,
              ],
            );
          },
        )),
      ],
    );
  }

  /// TASK-168: parses the leading `YYYY-MM-DD` of an ISO-8601 `createdAt`
  /// string. Real timestamps are always UTC (`Z`-suffixed) from the server;
  /// no timezone conversion is attempted here — this is a lightweight
  /// same-day grouping heuristic, not a calendar computation.
  bool _isSameDay(String a, String b) {
    return _dateOnly(a) == _dateOnly(b);
  }

  String _dateOnly(String isoTimestamp) {
    final tIndex = isoTimestamp.indexOf('T');
    return tIndex == -1 ? isoTimestamp : isoTimestamp.substring(0, tIndex);
  }

  String _dateDividerLabel(String createdAt) {
    final parsed = DateTime.tryParse(createdAt);
    if (parsed == null) return _dateOnly(createdAt);
    final local = parsed.toLocal();
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final messageDay = DateTime(local.year, local.month, local.day);
    final diffDays = today.difference(messageDay).inDays;
    if (diffDays == 0) return 'Today';
    if (diffDays == 1) return 'Yesterday';
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return '${months[local.month - 1]} ${local.day}, ${local.year}';
  }

  Widget _buildMessageBubble(BuildContext context, ThreadMessage message) {
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
            if (message.body.isNotEmpty)
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
            if (message.attachments.isNotEmpty) ...[
              if (message.body.isNotEmpty) const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  for (final attachment in message.attachments)
                    Chip(
                      key: Key('message-attachment-${attachment.id}'),
                      label: Text(attachment.filename),
                      visualDensity: VisualDensity.compact,
                    ),
                ],
              ),
            ],
            if (message.approval != null) ...[
              const SizedBox(height: 8),
              _ApprovalCard(
                message: message,
                status:
                    _approvalStatuses[message.id] ?? message.approval!.status,
                deciding: _decidingApprovals.contains(message.id),
                onDecide: (decision) => _decideApproval(message, decision),
              ),
            ],
            if (message.secretRequest != null) ...[
              const SizedBox(height: 8),
              SecretRequestCard(
                request: message.secretRequest!,
                status:
                    _secretRequestStatuses[message.id] ??
                    message.secretRequest!.status,
                busy: _decidingSecretRequests.contains(message.id),
                onProvide: (value) => _provideSecret(message, value),
                onDecline: () => _declineSecret(message),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildComposeBox() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_uploading)
              const Padding(
                padding: EdgeInsets.only(bottom: 8),
                child: LinearProgressIndicator(key: Key('attach-progress')),
              ),
            if (_uploadError != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  _uploadError!,
                  key: const Key('attach-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (_pendingAttachments.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    for (final attachment in _pendingAttachments)
                      Chip(
                        key: Key('pending-attachment-${attachment.id}'),
                        label: Text(attachment.filename),
                        onDeleted: _sending || _uploading
                            ? null
                            : () => setState(
                                  () => _pendingAttachments.remove(attachment),
                                ),
                      ),
                  ],
                ),
              ),
            // TASK-168: pill-shaped composer — a rounded translucent
            // container wrapping the existing attach/text/send row, rather
            // than a plain rectangular TextField. All existing keys and
            // behavior (attach button from TASK-166, send button) are
            // preserved unchanged; only the visual wrapper changes.
            Container(
              key: const Key('composer-pill'),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(28),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Row(
                children: [
                  IconButton(
                    key: const Key('attach-button'),
                    icon: const Icon(Icons.add),
                    tooltip: 'Attach file or image',
                    onPressed: _sending || _uploading ? null : _attach,
                  ),
                  Expanded(
                    child: TextField(
                      key: const Key('compose-field'),
                      controller: _composeController,
                      decoration: InputDecoration(
                        hintText: 'Ask ${widget.bot.botName}',
                        border: InputBorder.none,
                        contentPadding: const EdgeInsets.symmetric(
                          vertical: 12,
                        ),
                      ),
                      onSubmitted: (_) => _send(),
                      onChanged: (value) {
                        if (value == '/') _openSkillPicker();
                      },
                    ),
                  ),
                  IconButton(
                    key: const Key('send-button'),
                    icon: const Icon(Icons.send),
                    onPressed: _sending || _uploading ? null : _send,
                  ),
                ],
              ),
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
          key: Key('routine-${routine.id}'),
          title: Text(routine.name),
          subtitle: Text(
            'Schedule: ${routine.schedule ?? 'Not scheduled'}\n'
            'Last: ${routine.lastFireAt ?? 'Never'} · Next: ${routine.nextFireAt ?? 'Not scheduled'}',
          ),
          isThreeLine: true,
          onTap: () => _openRoutineDetail(routine),
        );
      },
    );
  }
}

/// TASK-168: small centered label inserted between message clusters that
/// cross a real day boundary (computed from `ThreadMessage.createdAt`).
class _DateDivider extends StatelessWidget {
  const _DateDivider({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final mutedColor = Theme.of(context).colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          Expanded(child: Divider(color: mutedColor.withValues(alpha: 0.3))),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text(
              label,
              style: Theme.of(context)
                  .textTheme
                  .labelSmall
                  ?.copyWith(color: mutedColor),
            ),
          ),
          Expanded(child: Divider(color: mutedColor.withValues(alpha: 0.3))),
        ],
      ),
    );
  }
}

class _HandoffChip extends StatelessWidget {
  const _HandoffChip(
      {required this.handoff,
      required this.otherName,
      required this.avatarSeed,
      required this.onTap});

  final RoleHandoff handoff;
  final String otherName;
  final String avatarSeed;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(right: 8),
        child: ActionChip(
          key: Key('handoff-chip-${handoff.id}'),
          avatar: BotAvatar(seed: avatarSeed, name: otherName, size: 22),
          label: Text('1 message with $otherName'),
          onPressed: onTap,
        ),
      );
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
  bool _loadingRole = true;
  String? _titleError;
  String? _instructionsError;
  bool _savingInstructions = false;
  final _titleController = TextEditingController();
  final _instructionsController = TextEditingController();
  List<Skill>? _skills;
  Set<String> _enabledSkillIds = {};
  String? _skillsError;
  final Set<String> _savingSkillIds = {};
  ThreadContext? _threadContext;

  @override
  void initState() {
    super.initState();
    _loadRole();
    _loadSkills();
    _loadThreadContext();
  }

  /// Moved here from the chat header (see chat_screen's own AppBar comment)
  /// — a full-width row has room for a label this widget's original
  /// 92dp-in-a-crowded-header placement never did.
  Future<void> _loadThreadContext() async {
    try {
      final context = await widget.apiClient.getThreadContext(widget.bot.id);
      if (mounted) {
        setState(() => _threadContext = context);
      }
    } catch (_) {
      // Metering is supplemental: a failure must not hide the rest of settings.
    }
  }

  Future<void> _loadSkills() async {
    try {
      final results = await Future.wait([
        widget.apiClient.listSkills(),
        widget.apiClient.listRoleSkills(widget.bot.roleId),
      ]);
      if (!mounted) return;
      final enabled = results[1];
      setState(() {
        _skills = results[0];
        _enabledSkillIds = enabled.map((skill) => skill.id).toSet();
      });
    } catch (_) {
      if (mounted) setState(() => _skillsError = 'Could not load skills.');
    }
  }

  Future<void> _setSkillEnabled(Skill skill, bool enabled) async {
    if (_savingSkillIds.contains(skill.id)) return;
    setState(() => _savingSkillIds.add(skill.id));
    try {
      final confirmed = await widget.apiClient.setRoleSkillEnabled(
        widget.bot.roleId,
        skill.id,
        enabled,
      );
      if (!mounted) return;
      setState(() {
        if (confirmed) {
          _enabledSkillIds.add(skill.id);
        } else {
          _enabledSkillIds.remove(skill.id);
        }
      });
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not update skill enablement.')),
        );
      }
    } finally {
      if (mounted) setState(() => _savingSkillIds.remove(skill.id));
    }
  }

  @override
  void dispose() {
    _titleController.dispose();
    _instructionsController.dispose();
    super.dispose();
  }

  /// Title is still read-only: no title-update route exists. Instructions
  /// are writable via the real `PATCH /roles/:roleId` body
  /// `{instructions: string}` (empty string clears).
  Future<void> _loadRole() async {
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
        _titleController.text = match?.title ?? '';
        _instructionsController.text = match?.instructions ?? '';
        _loadingRole = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _titleError = 'Could not load title.';
        _instructionsError = 'Could not load instructions.';
        _loadingRole = false;
      });
    }
  }

  Future<void> _saveInstructions() async {
    if (_savingInstructions) return;
    setState(() {
      _savingInstructions = true;
      _instructionsError = null;
    });
    try {
      await widget.apiClient.updateRoleInstructions(
        widget.bot.roleId,
        _instructionsController.text,
      );
      if (!mounted) return;
      setState(() {
        _savingInstructions = false;
      });
    } on UnauthorizedError {
      if (!mounted) return;
      Navigator.of(context).pop();
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _instructionsError = error.message;
        _savingInstructions = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _instructionsError = 'Failed to save instructions.';
        _savingInstructions = false;
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
          if (_threadContext case final threadContext?) ...[
            ContextMeter(
              used: threadContext.contextTokens,
              limit: threadContext.contextLimit,
              expanded: true,
            ),
            const SizedBox(height: 20),
          ],
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
          if (_loadingRole)
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
              controller: _titleController,
              decoration: InputDecoration(
                hintText: 'No title set',
                helperText: _titleError ??
                    'Read-only — no update endpoint exists for this yet.',
              ),
            ),
          const SizedBox(height: 20),
          const Text(
            'Instructions',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          if (!_loadingRole) ...[
            TextField(
              key: const Key('instructions-field'),
              controller: _instructionsController,
              minLines: 4,
              maxLines: 8,
              enabled: !_savingInstructions,
              decoration: const InputDecoration(
                hintText: 'Custom persona / system prompt for this bot',
              ),
            ),
            if (_instructionsError != null) ...[
              const SizedBox(height: 8),
              Text(
                _instructionsError!,
                key: const Key('instructions-error'),
                style: const TextStyle(color: Colors.red),
              ),
            ],
            const SizedBox(height: 12),
            ElevatedButton(
              key: const Key('instructions-save'),
              onPressed: _savingInstructions ? null : _saveInstructions,
              child:
                  Text(_savingInstructions ? 'Saving…' : 'Save instructions'),
            ),
          ],
          const SizedBox(height: 20),
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Skills',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                ),
              ),
              TextButton(
                key: const Key('skills-library-button'),
                onPressed: () => Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(
                    builder: (_) => SkillsScreen(apiClient: widget.apiClient),
                  ),
                ),
                child: const Text('Library'),
              ),
            ],
          ),
          if (_skillsError != null)
            Text(_skillsError!, key: const Key('settings-skills-error'))
          else if (_skills == null)
            const Padding(
              padding: EdgeInsets.all(8),
              child: CircularProgressIndicator(),
            )
          else if (_skills!.isEmpty)
            const Text('No skills in your library yet.')
          else
            for (final skill in _skills!)
              SwitchListTile(
                key: Key('skill-enable-${skill.id}'),
                title: Text('/${skill.name}'),
                subtitle: Text(skill.description),
                value: _enabledSkillIds.contains(skill.id),
                onChanged: _savingSkillIds.contains(skill.id)
                    ? null
                    : (enabled) => _setSkillEnabled(skill, enabled),
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
