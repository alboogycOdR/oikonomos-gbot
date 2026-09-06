import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';

/// Displays routine metadata plus its reconstructable history: tasks created
/// by the routine, followed by the actual runs for each task.
class RoutineDetailScreen extends StatefulWidget {
  const RoutineDetailScreen({
    super.key,
    required this.apiClient,
    required this.routine,
  });

  final ApiClient apiClient;
  final Routine routine;

  @override
  State<RoutineDetailScreen> createState() => _RoutineDetailScreenState();
}

class _RoutineDetailScreenState extends State<RoutineDetailScreen> {
  List<RoutineRun>? _runs;
  String? _error;
  late Routine _routine;
  bool _updatingRoutine = false;

  @override
  void initState() {
    super.initState();
    _routine = widget.routine;
    _loadHistory();
  }

  Future<void> _setPaused(bool paused) async {
    if (_updatingRoutine) {
      return;
    }
    setState(() => _updatingRoutine = true);
    try {
      final routine =
          await widget.apiClient.setRoutinePaused(_routine.id, paused);
      if (mounted) {
        setState(() => _routine = routine);
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not update routine.')));
      }
    } finally {
      if (mounted) {
        setState(() => _updatingRoutine = false);
      }
    }
  }

  Future<void> _confirmTestRun() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Test run'),
        content: const Text('test run performs real work'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Run test')),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    try {
      final result = await widget.apiClient.testRunRoutine(_routine.id);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(result.warning)));
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not start test run.')));
      }
    }
  }

  Future<void> _loadHistory() async {
    try {
      final tasks = await widget.apiClient.listRoutineTasks(widget.routine.id);
      final runLists = await Future.wait(
        tasks.map((task) => widget.apiClient.listRunsForTask(task.id)),
      );
      if (!mounted) return;
      final runs = runLists.expand((list) => list).toList()
        ..sort((a, b) => b.startedAt.compareTo(a.startedAt));
      setState(() => _runs = runs);
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load run history.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final routine = _routine;
    return Scaffold(
      appBar: AppBar(title: Text(routine.name)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(routine.name, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          Text('Schedule: ${routine.schedule ?? 'Not scheduled'}'),
          Text('Next run: ${routine.nextFireAt ?? 'Not scheduled'}'),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            key: const Key('routine-pause-resume'),
            onPressed:
                _updatingRoutine ? null : () => _setPaused(!routine.paused),
            icon: Icon(routine.paused ? Icons.play_arrow : Icons.pause),
            label: Text(routine.paused ? 'Resume routine' : 'Pause routine'),
          ),
          OutlinedButton.icon(
            key: const Key('routine-test-run'),
            onPressed: _confirmTestRun,
            icon: const Icon(Icons.play_circle_outline),
            label: const Text('Test run'),
          ),
          const SizedBox(height: 24),
          Text('Run history', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          if (_error != null)
            Text(_error!, key: const Key('routine-history-error'))
          else if (_runs == null)
            const Center(child: CircularProgressIndicator())
          else if (_runs!.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Text(
                'This routine has not run yet.',
                key: Key('routine-history-empty'),
              ),
            )
          else
            ..._runs!.map(
              (run) => ListTile(
                title: Text(run.startedAt),
                subtitle: Text('Status: ${run.status}'),
              ),
            ),
        ],
      ),
    );
  }
}
