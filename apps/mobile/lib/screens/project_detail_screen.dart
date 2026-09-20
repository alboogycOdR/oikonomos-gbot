import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';
import 'project_task_screen.dart';

/// The project workspace: charter, roster, board and its durable outputs.
class ProjectDetailScreen extends StatefulWidget {
  const ProjectDetailScreen({
    super.key,
    required this.apiClient,
    required this.projectId,
  });

  final ApiClient apiClient;
  final String projectId;

  @override
  State<ProjectDetailScreen> createState() => _ProjectDetailScreenState();
}

class _ProjectDetailScreenState extends State<ProjectDetailScreen> {
  ProjectDetail? _detail;
  List<ProjectTask>? _tasks;
  List<ProjectArtifact>? _artifacts;
  List<ProjectDecision>? _decisions;
  String? _error;
  String? _artifactsError;
  String? _decisionsError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    setState(() {
      _artifacts = null;
      _decisions = null;
      _artifactsError = null;
      _decisionsError = null;
    });
    try {
      final results = await Future.wait<Object>([
        widget.apiClient.getProject(widget.projectId),
        widget.apiClient.listProjectTasks(widget.projectId),
      ]);
      if (!mounted) return;
      setState(() {
        _detail = results[0] as ProjectDetail;
        _tasks = results[1] as List<ProjectTask>;
      });
      await Future.wait([_loadArtifacts(), _loadDecisions()]);
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load this project.');
    }
  }

  Future<void> _loadArtifacts() async {
    try {
      final artifacts =
          await widget.apiClient.listProjectArtifacts(widget.projectId);
      if (mounted) {
        setState(() => _artifacts = artifacts);
      }
    } on ApiException catch (error) {
      if (mounted) setState(() => _artifactsError = error.message);
    } catch (_) {
      if (mounted) {
        setState(() => _artifactsError = 'Could not load artifacts.');
      }
    }
  }

  Future<void> _loadDecisions() async {
    try {
      final decisions =
          await widget.apiClient.listProjectDecisions(widget.projectId);
      if (mounted) {
        setState(() => _decisions = decisions);
      }
    } on ApiException catch (error) {
      if (mounted) setState(() => _decisionsError = error.message);
    } catch (_) {
      if (mounted) {
        setState(() => _decisionsError = 'Could not load decisions.');
      }
    }
  }

  Future<void> _openTask(ProjectTask task) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => ProjectTaskScreen(
          apiClient: widget.apiClient,
          projectId: widget.projectId,
          task: task,
        ),
      ),
    );
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Project')),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(_error!, key: const Key('project-detail-error')),
              const SizedBox(height: 12),
              FilledButton(onPressed: _load, child: const Text('Try again')),
            ],
          ),
        ),
      );
    }
    if (_detail == null || _tasks == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final detail = _detail!;
    return Scaffold(
      appBar: AppBar(title: Text(detail.project.name)),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text('Charter', style: Theme.of(context).textTheme.titleLarge),
            Text(detail.project.goal),
            const SizedBox(height: 4),
            Text('Done when: ${detail.project.doneCriterion}'),
            if (detail.charter.isNotEmpty) ...[
              const SizedBox(height: 8),
              ...detail.charter.entries.map(
                (entry) => Text('${entry.key}: ${entry.value}'),
              ),
            ],
            const SizedBox(height: 20),
            Text('Roster', style: Theme.of(context).textTheme.titleLarge),
            if (detail.roster.isEmpty)
              const Text('No bots are assigned yet.')
            else
              ...detail.roster.map(
                (member) => ListTile(
                  dense: true,
                  title: Text(member.roleId),
                  subtitle: member.responsibility.isEmpty
                      ? null
                      : Text(member.responsibility),
                  trailing: member.isManager
                      ? const Chip(label: Text('Manager'))
                      : null,
                ),
              ),
            const SizedBox(height: 20),
            Text('Board', style: Theme.of(context).textTheme.titleLarge),
            ...projectTaskStates.map(
              (state) => _StateGroup(
                state: state,
                tasks: _tasks!.where((task) => task.state == state).toList(),
                onTap: _openTask,
              ),
            ),
            const SizedBox(height: 20),
            Text(
              'Artifact register',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            if (_artifactsError != null)
              Text(_artifactsError!, key: const Key('artifacts-error'))
            else if (_artifacts == null)
              const Center(child: CircularProgressIndicator())
            else if (_artifacts!.isEmpty)
              const Text(
                'No artifacts registered yet.',
                key: Key('artifacts-empty'),
              )
            else
              ..._artifacts!.map(
                (artifact) => ListTile(
                  key: Key('artifact-${artifact.artifactId}'),
                  title: Text(artifact.label),
                  subtitle: Text('${artifact.kind}: ${artifact.ref}'),
                ),
              ),
            const SizedBox(height: 20),
            Text('Decision log', style: Theme.of(context).textTheme.titleLarge),
            if (_decisionsError != null)
              Text(_decisionsError!, key: const Key('decisions-error'))
            else if (_decisions == null)
              const Center(child: CircularProgressIndicator())
            else if (_decisions!.isEmpty)
              const Text(
                'No decisions recorded yet.',
                key: Key('decisions-empty'),
              )
            else
              ..._decisions!.map(
                (decision) => ListTile(
                  key: Key('decision-${decision.decisionId}'),
                  title: Text(decision.summary),
                  subtitle: Text('${decision.kind} · ${decision.actor}'),
                ),
              ),
            const SizedBox(height: 20),
            Text(
              'Latest STATUS.md',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            if (detail.latestStatusArtifact == null)
              const Text(
                'No STATUS.md has been registered yet.',
                key: Key('status-empty'),
              )
            else
              ListTile(
                key: const Key('latest-status-artifact'),
                title: Text(detail.latestStatusArtifact!.label),
                subtitle: Text(detail.latestStatusArtifact!.ref),
              ),
          ],
        ),
      ),
    );
  }
}

class _StateGroup extends StatelessWidget {
  const _StateGroup({
    required this.state,
    required this.tasks,
    required this.onTap,
  });

  final String state;
  final List<ProjectTask> tasks;
  final ValueChanged<ProjectTask> onTap;

  @override
  Widget build(BuildContext context) => ExpansionTile(
        key: Key('board-state-$state'),
        initiallyExpanded: state == 'blocked',
        title: Text(
          '${state[0].toUpperCase()}${state.substring(1)} (${tasks.length})',
        ),
        children: tasks.isEmpty
            ? const [ListTile(title: Text('No work items.'))]
            : tasks
                .map(
                  (task) => ListTile(
                    key: Key('project-task-${task.taskId}'),
                    title: Text(task.title),
                    subtitle: task.state == 'blocked'
                        ? Text(
                            'Blocked: ${task.blockedReason ?? 'No reason supplied'}',
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.error,
                            ),
                          )
                        : Text(
                            task.ownerRoleId == null
                                ? 'Unassigned'
                                : 'Owner: ${task.ownerRoleId}',
                          ),
                    onTap: () => onTap(task),
                  ),
                )
                .toList(),
      );
}
