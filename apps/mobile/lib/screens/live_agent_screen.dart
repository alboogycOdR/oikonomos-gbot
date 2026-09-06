import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/live_agent_client.dart';

/// TASK-171 — the mobile live-agent/monitor view: a real, live-updating
/// terminal-style read of a role's current or most-recent OpenSandbox
/// sandbox activity, sourced from execd's PTY viewer mode
/// (`/pty/{id}/ws?mode=viewer&since=0`) via `LiveAgentClient`.
///
/// Three states, all real (never a fabricated placeholder):
///   - loading: brief spinner while `GET .../live-agent/status` resolves.
///   - empty: no active/recent sandboxed run — a clear message, not an
///     error and not an infinite spinner.
///   - live: real replay-then-live sandbox output, monospace, auto-
///     scrolling to the latest line as it arrives.
class LiveAgentScreen extends StatefulWidget {
  const LiveAgentScreen({
    super.key,
    required this.apiClient,
    required this.roleId,
    LiveAgentClient? client,
  }) : _client = client;

  final ApiClient apiClient;
  final String roleId;
  final LiveAgentClient? _client;

  @override
  State<LiveAgentScreen> createState() => _LiveAgentScreenState();
}

enum _LiveAgentViewState { loading, empty, live, error }

class _LiveAgentScreenState extends State<LiveAgentScreen> {
  late final LiveAgentClient _client =
      widget._client ?? LiveAgentClient(apiClient: widget.apiClient);
  final ScrollController _scrollController = ScrollController();
  final StringBuffer _output = StringBuffer();

  _LiveAgentViewState _state = _LiveAgentViewState.loading;
  String? _errorMessage;
  LiveAgentSubscription? _subscription;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final status = await _client.getStatus(widget.roleId);
      if (!mounted) return;
      if (!status.available) {
        setState(() => _state = _LiveAgentViewState.empty);
        return;
      }
      setState(() => _state = _LiveAgentViewState.live);
      _subscription = _client.watch(
        roleId: widget.roleId,
        onOutput: _appendOutput,
        onDone: () {
          if (!mounted) return;
          // The sandbox session ended — leave the transcript visible
          // rather than replacing it with an empty state (the run
          // happened; its output stays readable).
        },
        onError: (error) {
          if (!mounted) return;
          setState(() {
            _state = _LiveAgentViewState.error;
            _errorMessage = error.toString();
          });
        },
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _state = _LiveAgentViewState.error;
        _errorMessage = error.toString();
      });
    }
  }

  void _appendOutput(String chunk) {
    if (!mounted) return;
    setState(() => _output.write(chunk));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    });
  }

  @override
  void dispose() {
    _subscription?.close();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Live view')),
      body: switch (_state) {
        _LiveAgentViewState.loading => const Center(
            key: Key('live-agent-loading'),
            child: CircularProgressIndicator(),
          ),
        _LiveAgentViewState.empty => Center(
            key: const Key('live-agent-empty'),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                'No active or recent sandboxed run for this bot.',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
          ),
        _LiveAgentViewState.error => Center(
            key: const Key('live-agent-error'),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                _errorMessage ?? 'Could not load the live view.',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
          ),
        _LiveAgentViewState.live => Container(
            key: const Key('live-agent-terminal'),
            color: Colors.black,
            width: double.infinity,
            child: SingleChildScrollView(
              controller: _scrollController,
              padding: const EdgeInsets.all(12),
              child: SelectableText(
                _output.toString(),
                style: const TextStyle(
                  fontFamily: 'monospace',
                  color: Colors.greenAccent,
                  fontSize: 12,
                ),
              ),
            ),
          ),
      },
    );
  }
}
