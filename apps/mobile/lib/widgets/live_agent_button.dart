import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../screens/live_agent_screen.dart';

/// TASK-171 — the Grok-Bot-reference chat header icon that opens a live
/// view of the bot's current/most-recent sandboxed session.
///
/// A self-contained `IconButton`: the only wiring a chat header needs is
/// dropping this widget into its `AppBar.actions` with the current
/// `apiClient`/`roleId` — it owns its own navigation, so no other file
/// needs to know about `LiveAgentScreen`.
///
/// NOTE for the integrator (see dossiers/TASK-171.md): this task's
/// `Owned_Paths` does not include `chat_screen.dart`, so this widget is
/// not yet actually placed in any `AppBar.actions` list. Adding
/// `LiveAgentButton(apiClient: ..., roleId: ...)` to
/// `chat_screen.dart`'s existing `actions` array (see its
/// `bot-settings-button` `IconButton` for the sibling pattern) is the
/// entire remaining integration step.
class LiveAgentButton extends StatelessWidget {
  const LiveAgentButton({
    super.key,
    required this.apiClient,
    required this.roleId,
  });

  final ApiClient apiClient;
  final String roleId;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      key: const Key('live-agent-button'),
      tooltip: 'Live view',
      icon: const Icon(Icons.terminal_outlined),
      onPressed: () {
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => LiveAgentScreen(
              apiClient: apiClient,
              roleId: roleId,
            ),
          ),
        );
      },
    );
  }
}
