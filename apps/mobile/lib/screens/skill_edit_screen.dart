import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';

/// Create or edit the user-authored markdown contract for a skill.
class SkillEditScreen extends StatefulWidget {
  const SkillEditScreen({super.key, required this.apiClient, this.skill});

  final ApiClient apiClient;
  final Skill? skill;

  @override
  State<SkillEditScreen> createState() => _SkillEditScreenState();
}

class _SkillEditScreenState extends State<SkillEditScreen> {
  late final TextEditingController _name =
      TextEditingController(text: widget.skill?.name);
  late final TextEditingController _description =
      TextEditingController(text: widget.skill?.description);
  late final TextEditingController _whenToUse =
      TextEditingController(text: widget.skill?.whenToUse);
  late final TextEditingController _body =
      TextEditingController(text: widget.skill?.body);
  late final TextEditingController _approvals =
      TextEditingController(text: widget.skill?.approvals.join(', '));
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    _whenToUse.dispose();
    _body.dispose();
    _approvals.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final description = _description.text.trim();
    final body = _body.text.trim();
    if (name.isEmpty || description.isEmpty || body.isEmpty) {
      setState(
          () => _error = 'Name, description, and markdown body are required.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final approvals = _approvals.text
        .split(',')
        .map((item) => item.trim())
        .where((item) => item.isNotEmpty)
        .toList();
    try {
      final skill = widget.skill == null
          ? await widget.apiClient.createSkill(
              name: name,
              description: description,
              body: body,
              whenToUse: _whenToUse.text,
              approvals: approvals)
          : await widget.apiClient.updateSkill(widget.skill!.id,
              name: name,
              description: description,
              body: body,
              whenToUse: _whenToUse.text,
              approvals: approvals);
      if (mounted) {
        Navigator.of(context).pop(skill);
      }
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (error) {
      if (mounted) {
        setState(() {
          _error = error.message;
          _saving = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = 'Could not save skill.';
          _saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
            title: Text(widget.skill == null ? 'New skill' : 'Edit skill')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          TextField(
              key: const Key('skill-name-field'),
              controller: _name,
              decoration:
                  const InputDecoration(labelText: 'Name', prefixText: '/')),
          const SizedBox(height: 12),
          TextField(
              key: const Key('skill-description-field'),
              controller: _description,
              decoration: const InputDecoration(labelText: 'Description')),
          const SizedBox(height: 12),
          TextField(
              key: const Key('skill-when-to-use-field'),
              controller: _whenToUse,
              decoration: const InputDecoration(labelText: 'When to use')),
          const SizedBox(height: 12),
          TextField(
              key: const Key('skill-body-field'),
              controller: _body,
              minLines: 8,
              maxLines: null,
              decoration: const InputDecoration(
                  labelText: 'Body (Markdown)', alignLabelWithHint: true)),
          const SizedBox(height: 12),
          TextField(
              key: const Key('skill-approvals-field'),
              controller: _approvals,
              decoration: const InputDecoration(
                  labelText: 'Approvals',
                  helperText: 'Comma-separated approval requirements')),
          if (_error != null)
            Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(_error!,
                    key: const Key('skill-save-error'),
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error))),
          const SizedBox(height: 20),
          ElevatedButton(
              key: const Key('skill-save-button'),
              onPressed: _saving ? null : _save,
              child: Text(_saving ? 'Saving…' : 'Save skill')),
        ]),
      );
}
