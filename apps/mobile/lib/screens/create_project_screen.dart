import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';

/// Spec §1.1 roster cap; the server enforces it too and its own rejection
/// is surfaced verbatim if it disagrees.
const int kProjectRosterCap = 6;

/// TASK-307 (P-7a) — create a project: name, goal, done criterion, charter
/// (boundaries / check-with-me-before), pick up to six existing bots and
/// optionally mark one as manager. Pops `true` on success.
class CreateProjectScreen extends StatefulWidget {
  const CreateProjectScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<CreateProjectScreen> createState() => _CreateProjectScreenState();
}

class _CreateProjectScreenState extends State<CreateProjectScreen> {
  final _name = TextEditingController();
  final _goal = TextEditingController();
  final _done = TextEditingController();
  final _boundaries = TextEditingController();
  final _checkWithMe = TextEditingController();

  List<Role> _roles = const [];
  bool _loadingRoles = true;
  String? _rolesError;
  final Set<String> _selected = {};
  String? _managerId;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadRoles();
  }

  @override
  void dispose() {
    _name.dispose();
    _goal.dispose();
    _done.dispose();
    _boundaries.dispose();
    _checkWithMe.dispose();
    super.dispose();
  }

  Future<void> _loadRoles() async {
    try {
      final roles = await widget.apiClient.listRoles();
      if (mounted) setState(() => _roles = roles);
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (mounted) setState(() => _rolesError = 'Could not load bots.');
    } finally {
      if (mounted) setState(() => _loadingRoles = false);
    }
  }

  bool get _canSubmit =>
      !_saving &&
      _name.text.trim().isNotEmpty &&
      _goal.text.trim().isNotEmpty &&
      _done.text.trim().isNotEmpty &&
      _selected.isNotEmpty;

  void _toggle(Role role, bool on) {
    setState(() {
      if (on) {
        if (_selected.length >= kProjectRosterCap) {
          _error = 'A project can have at most $kProjectRosterCap bots.';
          return;
        }
        _selected.add(role.id);
      } else {
        _selected.remove(role.id);
        if (_managerId == role.id) _managerId = null;
      }
      _error = null;
    });
  }

  /// At most one manager: marking a second one moves the flag.
  void _setManager(Role role, bool on) {
    setState(() => _managerId = on ? role.id : null);
  }

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    String? opt(TextEditingController c) {
      final v = c.text.trim();
      return v.isEmpty ? null : v;
    }

    try {
      await widget.apiClient.createProject(
        name: _name.text.trim(),
        goal: _goal.text.trim(),
        doneCriterion: _done.text.trim(),
        boundaries: opt(_boundaries),
        checkWithMeBefore: opt(_checkWithMe),
        roster: [
          for (final id in _selected)
            {'roleId': id, if (id == _managerId) 'isManager': true},
        ],
      );
      if (mounted) Navigator.of(context).pop(true);
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not create the project.');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('New project')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            key: const Key('project-name'),
            controller: _name,
            decoration: const InputDecoration(labelText: 'Name'),
            onChanged: (_) => setState(() {}),
          ),
          TextField(
            key: const Key('project-goal'),
            controller: _goal,
            decoration: const InputDecoration(labelText: 'Goal'),
            onChanged: (_) => setState(() {}),
          ),
          TextField(
            key: const Key('project-done'),
            controller: _done,
            decoration: const InputDecoration(labelText: 'Done criterion'),
            onChanged: (_) => setState(() {}),
          ),
          TextField(
            key: const Key('project-boundaries'),
            controller: _boundaries,
            decoration: const InputDecoration(labelText: 'Boundaries'),
          ),
          TextField(
            key: const Key('project-check-with-me'),
            controller: _checkWithMe,
            decoration: const InputDecoration(labelText: 'Check with me before'),
          ),
          const SizedBox(height: 16),
          Text(
            'Bots (${_selected.length}/$kProjectRosterCap) — mark at most one as manager',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          if (_loadingRoles)
            const Center(child: CircularProgressIndicator())
          else if (_rolesError != null)
            Text(_rolesError!, key: const Key('project-roles-error'))
          else
            for (final role in _roles)
              Row(
                key: Key('project-role-${role.id}'),
                children: [
                  Checkbox(
                    key: Key('project-pick-${role.id}'),
                    value: _selected.contains(role.id),
                    onChanged: (v) => _toggle(role, v ?? false),
                  ),
                  Expanded(child: Text(role.name)),
                  if (_selected.contains(role.id)) ...[
                    const Text('Manager'),
                    Switch(
                      key: Key('project-manager-${role.id}'),
                      value: _managerId == role.id,
                      onChanged: (v) => _setManager(role, v),
                    ),
                  ],
                ],
              ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                _error!,
                key: const Key('project-create-error'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          const SizedBox(height: 16),
          FilledButton(
            key: const Key('project-create-submit'),
            onPressed: _canSubmit ? _submit : null,
            child: _saving
                ? const SizedBox(
                    height: 18,
                    width: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Create project'),
          ),
        ],
      ),
    );
  }
}
