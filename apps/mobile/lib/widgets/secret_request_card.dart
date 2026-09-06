import 'package:flutter/material.dart';

import '../api/models.dart';

/// TASK-187 (G-05b) — the human half of TASK-184's `request_secret` MCP
/// tool: an inline thread card asking the human to provide (or decline) a
/// value the bot needs, without ever placing that value in the transcript
/// or showing it to the model (report C13).
///
/// The typed value never leaves this widget except via [onProvide]'s single
/// argument — it is never logged, never included in analytics, and the
/// controller is cleared immediately after submission and again on
/// [dispose] (non-negotiable 4: no credentials in prompts, logs, or
/// fixtures). The masked field additionally disables interactive selection
/// so the value cannot be copied into the platform clipboard, autocorrect,
/// and predictive suggestions, per the spec's "no clipboard history where
/// the platform allows".
class SecretRequestCard extends StatefulWidget {
  const SecretRequestCard({
    super.key,
    required this.request,
    required this.status,
    required this.busy,
    required this.onProvide,
    required this.onDecline,
  });

  final SecretRequestRef request;

  /// `'pending'` shows the input form. Any other value (e.g.
  /// `'Provided · secret://…'`, `'Declined'`, or an error message such as
  /// `'Already decided or no longer valid.'`) collapses the card to a
  /// single status line instead.
  final String status;
  final bool busy;
  final Future<void> Function(String value) onProvide;
  final Future<void> Function() onDecline;

  @override
  State<SecretRequestCard> createState() => _SecretRequestCardState();
}

class _SecretRequestCardState extends State<SecretRequestCard> {
  final TextEditingController _controller = TextEditingController();
  bool _obscure = true;

  @override
  void dispose() {
    // Never leave the typed value sitting in a disposed controller.
    _controller.clear();
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final value = _controller.text;
    if (value.trim().isEmpty) return;
    _controller.clear();
    await widget.onProvide(value);
  }

  @override
  Widget build(BuildContext context) {
    final pending = widget.status == 'pending';
    return Card(
      key: Key('secret-request-card-${widget.request.requestId}'),
      color: Theme.of(context).colorScheme.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Asking for: ${widget.request.label}',
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            Text(widget.request.purpose),
            const SizedBox(height: 8),
            if (pending) ...[
              TextField(
                key: const Key('secret-request-input'),
                controller: _controller,
                obscureText: _obscure,
                autocorrect: false,
                enableSuggestions: false,
                enableInteractiveSelection: false,
                enableIMEPersonalizedLearning: false,
                keyboardType: TextInputType.visiblePassword,
                autofillHints: const [],
                decoration: InputDecoration(
                  labelText: widget.request.label,
                  border: const OutlineInputBorder(),
                  isDense: true,
                  suffixIcon: IconButton(
                    key: const Key('secret-request-toggle-obscure'),
                    icon: Icon(
                      _obscure ? Icons.visibility : Icons.visibility_off,
                    ),
                    onPressed: () => setState(() => _obscure = !_obscure),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  ElevatedButton(
                    key: const Key('secret-request-provide'),
                    onPressed: widget.busy ? null : _submit,
                    child: const Text('Provide'),
                  ),
                  const SizedBox(width: 8),
                  TextButton(
                    key: const Key('secret-request-decline'),
                    onPressed: widget.busy ? null : widget.onDecline,
                    child: const Text('Decline'),
                  ),
                ],
              ),
            ] else
              Text(
                widget.status,
                key: Key('secret-request-status-${widget.request.requestId}'),
              ),
          ],
        ),
      ),
    );
  }
}
