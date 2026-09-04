import 'package:flutter/material.dart';

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

class ChatScreenState extends State<ChatScreen> {
  final _composeController = TextEditingController();
  final List<ThreadMessage> _messages = [];
  final Set<String> _seenMessageIds = {};
  bool _loading = true;
  bool _sending = false;
  String? _error;
  SseSubscription? _subscription;

  /// Exposed for tests: true once the SSE subscription has been opened
  /// (and not yet closed) for this screen instance.
  bool get hasOpenSubscription => _subscription != null;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _subscription?.close();
    _subscription = null;
    _composeController.dispose();
    super.dispose();
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
      final messages = await widget.apiClient.listThreadMessages(
        widget.bot.id,
      );
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
      ),
      body: Column(
        children: [Expanded(child: _buildBody()), _buildComposeBox()],
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
            child: Text(
              message.body,
              style: TextStyle(color: isUser ? Colors.white : null),
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
                decoration: const InputDecoration(hintText: 'Message'),
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
}
