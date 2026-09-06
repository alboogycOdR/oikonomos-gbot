import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';
import 'skill_edit_screen.dart';

/// Account skills library. Enablement deliberately belongs to bot settings.
class SkillsScreen extends StatefulWidget {
  const SkillsScreen({super.key, required this.apiClient});
  final ApiClient apiClient;
  @override
  State<SkillsScreen> createState() => _SkillsScreenState();
}

class _SkillsScreenState extends State<SkillsScreen> {
  List<Skill>? _skills;
  String? _error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final skills = await widget.apiClient.listSkills();
      if (mounted) setState(() => _skills = skills);
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load skills.');
    }
  }

  Future<void> _edit([Skill? skill]) async {
    final saved = await Navigator.of(context).push<Skill>(MaterialPageRoute(
        builder: (_) =>
            SkillEditScreen(apiClient: widget.apiClient, skill: skill)));
    if (saved != null) _load();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Skills library')),
        floatingActionButton: FloatingActionButton(
            key: const Key('create-skill-button'),
            onPressed: () => _edit(),
            child: const Icon(Icons.add)),
        body: _error != null
            ? Center(child: Text(_error!, key: const Key('skills-error')))
            : _skills == null
                ? const Center(child: CircularProgressIndicator())
                : _skills!.isEmpty
                    ? const Center(
                        child: Text('No skills yet.', key: Key('skills-empty')))
                    : ListView.builder(
                        itemCount: _skills!.length,
                        itemBuilder: (_, index) {
                          final skill = _skills![index];
                          return ListTile(
                              key: Key('skill-tile-${skill.id}'),
                              title: Text('/${skill.name}'),
                              subtitle:
                                  Text(skill.whenToUse ?? skill.description),
                              trailing: const Icon(Icons.chevron_right),
                              onTap: () => _edit(skill));
                        },
                      ),
      );
}
