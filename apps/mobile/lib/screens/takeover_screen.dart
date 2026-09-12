import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/live_agent_client.dart';

/// TASK-228 (G-07 part 2) — the genuinely interactive take-over view:
/// unlike [LiveAgentScreen] (TASK-171, read-only), the human can actually
/// type here, and what they type reaches the real sandbox (a password, a
/// 2FA code, whatever the login wall/CAPTCHA/payment step needs) via
/// `LiveAgentClient.takeover` / `services/control-api/src/liveAgent.routes.ts`'s
/// `relayTakeover`.
///
/// ADR-010's enforced set (password/2FA/CAPTCHA/payment = human
/// takeover, never typed by the model) is what this screen exists to
/// serve: it is opened only when a run has already parked on exactly
/// that signal, and the human — not the bot — is the one typing here.
///
/// Three states, same convention as [LiveAgentScreen]: loading, empty
/// (no active/recent sandbox — nothing to take over), live (real replay-
/// then-live output, plus a real input to send keystrokes).
class TakeoverScreen extends StatefulWidget {
  const TakeoverScreen({
    super.key,
    required this.apiClient,
    required this.roleId,
    LiveAgentClient? client,
  }) : _client = client;

  final ApiClient apiClient;
  final String roleId;
  final LiveAgentClient? _client;

  @override
  State<TakeoverScreen> createState() => _TakeoverScreenState();
}

enum _TakeoverViewState { loading, empty, live, error }

class _TakeoverScreenState extends State<TakeoverScreen> {
  late final LiveAgentClient _client =
      widget._client ?? LiveAgentClient(apiClient: widget.apiClient);
  final ScrollController _scrollController = ScrollController();
  final TextEditingController _inputController = TextEditingController();
  final StringBuffer _output = StringBuffer();

  _TakeoverViewState _state = _TakeoverViewState.loading;
  String? _errorMessage;
  TakeoverSubscription? _subscription;

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
        setState(() => _state = _TakeoverViewState.empty);
        return;
      }
      setState(() => _state = _TakeoverViewState.live);
      _subscription = _client.takeover(
        roleId: widget.roleId,
        onOutput: _appendOutput,
        onDone: () {
          // The sandbox session (or the take-over connection itself)
          // ended — leave the transcript visible rather than replacing
          // it with an empty state.
        },
        onError: (error) {
          if (!mounted) return;
          setState(() {
            _state = _TakeoverViewState.error;
            _errorMessage = error.toString();
          });
        },
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _state = _TakeoverViewState.error;
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

  void _send() {
    final text = _inputController.text;
    if (text.isEmpty) return;
    // A real terminal expects a trailing newline to submit a line —
    // matches what a human pressing Enter in a real shell sends.
    _subscription?.send('$text\n');
    _inputController.clear();
  }

  @override
  void dispose() {
    _subscription?.close();
    _scrollController.dispose();
    _inputController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Take over')),
      body: switch (_state) {
        _TakeoverViewState.loading => const Center(
            key: Key('takeover-loading'),
            child: CircularProgressIndicator(),
          ),
        _TakeoverViewState.empty => Center(
            key: const Key('takeover-empty'),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                'No active or recent sandboxed run for this bot.',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
          ),
        _TakeoverViewState.error => Center(
            key: const Key('takeover-error'),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                _errorMessage ?? 'Could not load the take-over view.',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
          ),
        _TakeoverViewState.live => Column(
            children: [
              Expanded(
                child: Container(
                  key: const Key('takeover-terminal'),
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
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          key: const Key('takeover-input'),
                          controller: _inputController,
                          style: const TextStyle(fontFamily: 'monospace'),
                          decoration: const InputDecoration(
                            hintText: 'Type here — password, code, etc.',
                            isDense: true,
                            border: OutlineInputBorder(),
                          ),
                          onSubmitted: (_) => _send(),
                        ),
                      ),
                      IconButton(
                        key: const Key('takeover-send'),
                        icon: const Icon(Icons.send),
                        onPressed: _send,
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
      },
    );
  }
}
