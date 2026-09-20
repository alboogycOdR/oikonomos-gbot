import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';

/// A work item's human transition surface. The server remains authoritative.
class ProjectTaskScreen extends StatefulWidget {
  const ProjectTaskScreen({
    super.key,
    required this.apiClient,
    required this.projectId,
    required this.task,
  });

  final ApiClient apiClient;
  final String projectId;
  final ProjectTask task;

  @override
  State<ProjectTaskScreen> createState() => _ProjectTaskScreenState();
}

class _ProjectTaskScreenState extends State<ProjectTaskScreen> {
  late ProjectTask _task;
  List<ProjectArtifact>? _artifacts;
  String? _error;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _task = widget.task;
    _loadArtifacts();
  }

  Future<void> _loadArtifacts() async {
    try {
      final artifacts = await widget.apiClient.listProjectArtifacts(
        widget.projectId,
      );
      if (mounted) {
        setState(
          () => _artifacts =
              artifacts.where((a) => a.taskId == _task.taskId).toList(),
        );
      }
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load linked artifacts.');
    }
  }

  Future<void> _transition(String state) async {
    String? reason;
    if (state == 'blocked') {
      reason = await _blockedReason();
      if (reason == null || reason.trim().isEmpty) return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final updated = await widget.apiClient.updateProjectTask(
        widget.projectId,
        _task.taskId,
        state: state,
        blockedReason: reason,
      );
      if (mounted) setState(() => _task = updated);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not update this work item.');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<String?> _blockedReason() async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Why is this blocked?'),
        content: TextField(
          key: const Key('blocked-reason-input'),
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Blocked reason'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('blocked-reason-submit'),
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('Mark blocked'),
          ),
        ],
      ),
    );
    // Route removal rebuilds the dialog for one final frame.
    WidgetsBinding.instance.addPostFrameCallback((_) => controller.dispose());
    return result;
  }

  @override
  Widget build(BuildContext context) {
    final transitions = projectTaskTransitions[_task.state] ?? const <String>[];
    return Scaffold(
      appBar: AppBar(title: const Text('Work item')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(_task.title, style: Theme.of(context).textTheme.headlineSmall),
          if (_task.description.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_task.description),
            ),
          const SizedBox(height: 12),
          Text('Owner: ${_task.ownerRoleId ?? 'Unassigned'}'),
          Text('State: ${_task.state}', key: const Key('task-state')),
          if (_task.blockedReason != null)
            Text(
              'Blocked reason: ${_task.blockedReason}',
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          const SizedBox(height: 16),
          Text('Move to', style: Theme.of(context).textTheme.titleMedium),
          if (transitions.isEmpty)
            const Text('This work item is closed.')
          else
            Wrap(
              spacing: 8,
              children: transitions
                  .map(
                    (state) => OutlinedButton(
                      key: Key('transition-$state'),
                      onPressed: _saving ? null : () => _transition(state),
                      child: Text(state),
                    ),
                  )
                  .toList(),
            ),
          if (_saving)
            const Padding(
              padding: EdgeInsets.all(12),
              child: Center(child: CircularProgressIndicator()),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                _error!,
                key: const Key('task-update-error'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          const SizedBox(height: 20),
          Text(
            'Linked artifacts',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          if (_artifacts == null)
            const Center(child: CircularProgressIndicator())
          else if (_artifacts!.isEmpty)
            const Text('No artifacts linked to this work item.')
          else
            ..._artifacts!.map(
              (artifact) => ListTile(
                title: Text(artifact.label),
                subtitle: Text(artifact.ref),
              ),
            ),
        ],
      ),
    );
  }
}
