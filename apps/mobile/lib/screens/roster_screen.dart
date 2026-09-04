import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';
import '../widgets/avatar.dart';
import 'chat_screen.dart';
import 'create_bot_screen.dart';
import 'login_screen.dart';

/// TASK-147 (Mobile Wave 1b) — bot roster, the landing screen after login.
/// Mirrors `apps/dashboard/src/components/chat/BotSidebar.tsx` /
/// `ChatPage.tsx`'s `toBotSummary`: v1 is one thread per bot, so the
/// roster is `GET /threads` filtered to single-role threads
/// ([SingleThread]). Group threads ([GroupThread]) are deliberately
/// excluded here — the group-chat screen is out of scope for this task
/// (WORKFLOW_MOBILE_W1_W2_2026-09-04.md's deferred list) rather than
/// rendered with a shape this screen doesn't understand.
class RosterScreen extends StatefulWidget {
  const RosterScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<RosterScreen> createState() => _RosterScreenState();
}

class _RosterScreenState extends State<RosterScreen> {
  List<SingleThread> _bots = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final threads = await widget.apiClient.listThreads();
      final bots = threads.whereType<SingleThread>().toList()
        ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
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

  void _openChat(SingleThread bot) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ChatScreen(apiClient: widget.apiClient, bot: bot),
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
          title: Text(bot.botName),
          subtitle: bot.lastMessagePreview.isEmpty
              ? null
              : Text(
                  bot.lastMessagePreview,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
          trailing: Text(_formatRelative(bot.updatedAt)),
          onTap: () => _openChat(bot),
        );
      },
    );
  }
}
