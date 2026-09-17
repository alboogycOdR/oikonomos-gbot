import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';

/// Tenant-private template library. Installation always creates a distinct
/// role; integrations remain a human-reviewed checklist after creation.
class TemplatesScreen extends StatefulWidget {
  const TemplatesScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<TemplatesScreen> createState() => _TemplatesScreenState();
}

class _TemplatesScreenState extends State<TemplatesScreen> {
  List<TemplateSummary> _templates = const [];
  bool _loading = true;
  String? _error;
  String? _installingId;

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
      final templates = await widget.apiClient.listTemplates();
      if (!mounted) return;
      setState(() => _templates = templates);
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _install(TemplateSummary template) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Install as new bot?'),
        content:
            Text('This creates a new independent bot from ${template.name}.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Install'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _installingId = template.templateId);
    try {
      final result = await widget.apiClient.installTemplate(
        template.templateId,
        template.version,
      );
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Template installed'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Created role: ${result.roleId}'),
                const SizedBox(height: 12),
                const Text('Integration grant checklist'),
                const SizedBox(height: 4),
                if (result.grantChecklist.isEmpty)
                  const Text('No manual integration grants are needed.')
                else
                  ...result.grantChecklist.map(
                    (entry) => Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        '${entry.capabilityId}: ${entry.status} '
                        '(requested ${entry.requestedMaxTier})',
                      ),
                    ),
                  ),
                if (result.next.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Text(result.next),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Close'),
            ),
          ],
        ),
      );
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Template install failed: ${error.message}')),
        );
      }
    } finally {
      if (mounted) setState(() => _installingId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Templates')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!, textAlign: TextAlign.center),
                        const SizedBox(height: 12),
                        FilledButton(
                          onPressed: _load,
                          child: const Text('Try again'),
                        ),
                      ],
                    ),
                  ),
                )
              : _templates.isEmpty
                  ? const Center(child: Text('No templates yet.'))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(16),
                        itemCount: _templates.length,
                        separatorBuilder: (_, __) => const Divider(),
                        itemBuilder: (context, index) {
                          final template = _templates[index];
                          final installing =
                              _installingId == template.templateId;
                          return ListTile(
                            title: Text(template.name),
                            subtitle: Text('Version ${template.version}'),
                            trailing: FilledButton(
                              onPressed:
                                  installing ? null : () => _install(template),
                              child: installing
                                  ? const SizedBox(
                                      height: 18,
                                      width: 18,
                                      child: CircularProgressIndicator(
                                          strokeWidth: 2),
                                    )
                                  : const Text('Install'),
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
