import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';

/// TASK-158 (Mobile Wave 8) — routine creation flow, extending TASK-148's
/// read-only routines tab (`ChatScreenState._buildRoutines`) with the
/// missing write path. Mirrors `CreateBotScreen`'s form-screen pattern:
/// a dedicated pushed screen, client-side validation before any request
/// fires, and a server error surfaced inline rather than a generic crash.
///
/// Three inputs, per the task's explicit scoping:
///  - `name` (required, non-empty) — sent as-is.
///  - `schedule` (required, non-empty) — exposed as a plain cron-expression
///    text field for now; a friendlier "weekdays at 8:00 AM" picker that
///    translates to cron is a nicer UX but is a separable follow-up, not
///    required here. Server-side cron validation (`nextFireAtFromCron` in
///    `services/control-api/src/app.ts`) rejects an invalid expression with
///    a 400, which `ApiClient` turns into an [ApiException] carrying the
///    server's message — shown here as [_error], not swallowed.
///  - `goal` (optional) — maps to `definition: {goal}`
///    (`services/worker/src/jobs/routineJob.ts` reads this as the created
///    task's instruction) only when non-empty; `ApiClient.createRoutine`
///    already omits `definition` entirely otherwise.
///
/// On success this screen pops with `true` (mirroring `CreateBotScreen`'s
/// `pop(true)`/`pop(false)` convention) so the routines tab can refresh its
/// list without the user leaving and re-entering the screen.
class CreateRoutineScreen extends StatefulWidget {
  const CreateRoutineScreen({
    super.key,
    required this.apiClient,
    required this.roleId,
  });

  final ApiClient apiClient;
  final String roleId;

  @override
  State<CreateRoutineScreen> createState() => CreateRoutineScreenState();
}

class CreateRoutineScreenState extends State<CreateRoutineScreen> {
  final _nameController = TextEditingController();
  final _scheduleController = TextEditingController();
  final _goalController = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _nameController.dispose();
    _scheduleController.dispose();
    _goalController.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    final name = _nameController.text.trim();
    final schedule = _scheduleController.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Give the routine a name before creating it.');
      return;
    }
    if (schedule.isEmpty) {
      setState(() => _error = 'A schedule (cron expression) is required.');
      return;
    }
    if (_submitting) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await widget.apiClient.createRoutine(
        widget.roleId,
        name,
        schedule,
        goal: _goalController.text,
      );
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on UnauthorizedError {
      if (!mounted) return;
      Navigator.of(context).pop(false);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _submitting = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Failed to create routine.';
        _submitting = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('New routine')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: ListView(
          children: [
            TextField(
              key: const Key('routine-name-field'),
              controller: _nameController,
              decoration: const InputDecoration(labelText: 'Name'),
              onChanged: (_) => setState(() {
                if (_error != null) _error = null;
              }),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('routine-schedule-field'),
              controller: _scheduleController,
              decoration: const InputDecoration(
                labelText: 'Schedule (cron expression)',
                hintText: 'e.g. 0 8 * * 1-5',
                helperText: 'Standard 5-field cron — minute hour day month weekday.',
              ),
              onChanged: (_) => setState(() {
                if (_error != null) _error = null;
              }),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('routine-goal-field'),
              controller: _goalController,
              decoration: const InputDecoration(
                labelText: 'Instruction (optional)',
                hintText: 'What should this routine do?',
              ),
              maxLines: 3,
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                key: const Key('create-routine-error'),
                style: const TextStyle(color: Colors.red),
              ),
            ],
            const SizedBox(height: 24),
            ElevatedButton(
              key: const Key('create-routine-submit'),
              onPressed: _submitting ? null : submit,
              child: Text(_submitting ? 'Creating…' : 'Create routine'),
            ),
          ],
        ),
      ),
    );
  }
}
