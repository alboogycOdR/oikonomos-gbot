import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';

/// Bottom-sheet slash picker. The API's enabled-only endpoint is the sole
/// client filter; it does not attempt to reproduce server authorization.
class SkillPicker extends StatefulWidget {
  const SkillPicker({super.key, required this.apiClient, required this.roleId});
  final ApiClient apiClient;
  final String roleId;
  @override
  State<SkillPicker> createState() => _SkillPickerState();
}

class _SkillPickerState extends State<SkillPicker> {
  List<Skill>? _skills;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final skills = await widget.apiClient.listRoleSkills(widget.roleId);
      if (mounted) setState(() => _skills = skills);
    } catch (_) {
      if (mounted) setState(() => _skills = const []);
    }
  }

  @override
  Widget build(BuildContext context) => SafeArea(
          child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        child: _skills == null
            ? const SizedBox(
                height: 120, child: Center(child: CircularProgressIndicator()))
            : Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                    Text('Use a skill',
                        style: Theme.of(context).textTheme.titleLarge),
                    const SizedBox(height: 8),
                    if (_skills!.isEmpty)
                      const Padding(
                          padding: EdgeInsets.symmetric(vertical: 20),
                          child: Text('No skills are enabled for this bot.')),
                    for (final skill in _skills!)
                      ListTile(
                          key: Key('skill-picker-${skill.id}'),
                          title: Text('/${skill.name}'),
                          subtitle: Text(skill.description),
                          onTap: () => Navigator.of(context).pop(skill)),
                  ]),
      ));
}
