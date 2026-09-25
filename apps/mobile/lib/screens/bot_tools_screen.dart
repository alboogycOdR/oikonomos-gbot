import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import 'skills_screen.dart';

/// Per-bot connector capability controls. The server remains authoritative:
/// after each mutation this screen reloads the catalog rather than assuming a
/// local switch value is the final grant state.
class BotToolsScreen extends StatefulWidget {
  const BotToolsScreen({
    super.key,
    required this.apiClient,
    required this.roleId,
  });

  final ApiClient apiClient;
  final String roleId;

  @override
  State<BotToolsScreen> createState() => _BotToolsScreenState();
}

class _BotToolsScreenState extends State<BotToolsScreen> {
  RoleToolCatalog? _catalog;
  String? _error;
  final Set<String> _savingToolIds = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final catalog = await widget.apiClient.listRoleTools(widget.roleId);
      if (!mounted) {
        return;
      }
      setState(() {
        _catalog = catalog;
        _error = null;
      });
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not load connectors and tools.');
      }
    }
  }

  Future<void> _setGranted(RoleTool tool, bool granted) async {
    if (!tool.grantable || _savingToolIds.contains(tool.id)) return;
    setState(() => _savingToolIds.add(tool.id));
    try {
      if (granted) {
        await widget.apiClient.grantRoleTool(widget.roleId, tool);
      } else {
        await widget.apiClient.revokeRoleTool(widget.roleId, tool.id);
      }
      await _load();
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not update this tool.')),
        );
      }
    } finally {
      if (mounted) setState(() => _savingToolIds.remove(tool.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final catalog = _catalog;
    return Scaffold(
      appBar: AppBar(title: const Text('Connectors & tools')),
      body: _error != null
          ? Center(child: Text(_error!, key: const Key('bot-tools-error')))
          : catalog == null
              ? const Center(child: CircularProgressIndicator())
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (catalog.systems.isEmpty)
                      const Text(
                        'No connectors or tools are available yet.',
                        key: Key('bot-tools-empty'),
                      ),
                    for (final system in catalog.systems) ...[
                      Row(
                        children: [
                          Text(
                            system.label,
                            key: Key('tool-system-${system.id}'),
                            style: const TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          if (system.configured == false) ...[
                            const SizedBox(width: 8),
                            Chip(
                              key: Key(
                                  'tool-system-not-configured-${system.id}'),
                              label: const Text('Not configured'),
                              visualDensity: VisualDensity.compact,
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 4),
                      for (final tool in system.tools)
                        SwitchListTile(
                          key: Key('tool-grant-${tool.id}'),
                          contentPadding: EdgeInsets.zero,
                          title: Text(tool.label),
                          subtitle: Text(system.configured == false
                              ? '${tool.description}\nAsk the workspace owner to configure this connector'
                              : tool.grantable
                                  ? tool.description
                                  : '${tool.description}\nLocked — this tool cannot be changed here.'),
                          isThreeLine:
                              system.configured == false || !tool.grantable,
                          value: tool.granted,
                          onChanged: system.configured == false ||
                                  !tool.grantable ||
                                  _savingToolIds.contains(tool.id)
                              ? null
                              : (granted) => _setGranted(tool, granted),
                        ),
                      const SizedBox(height: 16),
                    ],
                    const Divider(height: 32),
                    ListTile(
                      key: const Key('bot-tools-skills-button'),
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Skills'),
                      subtitle:
                          const Text('Manage reusable skills in your library.'),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => Navigator.of(context).push<void>(
                        MaterialPageRoute<void>(
                          builder: (_) =>
                              SkillsScreen(apiClient: widget.apiClient),
                        ),
                      ),
                    ),
                  ],
                ),
    );
  }
}
