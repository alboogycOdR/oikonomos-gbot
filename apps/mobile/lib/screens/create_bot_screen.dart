import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';
import '../charter/charter_template.dart';
import '../widgets/avatar.dart';

/// TASK-147 (Mobile Wave 1b) — create-bot flow: name + description +
/// color/shape picker, then `POST /roles` followed by `POST /threads` so
/// the new bot has a working conversation immediately. Mirrors
/// `apps/dashboard/src/components/chat/CreateBotDialog.tsx`'s two-call
/// sequence and its "no manifest/tier field" scoping — `POST /roles`
/// (services/control-api/src/app.ts) grants only built-in capabilities
/// server-side and accepts no tier/capability input from either client.
///
/// The selection uses the API's stable 12-color/8-shape token contract and
/// is persisted with the new role, rather than being a local preview only.
class CreateBotScreen extends StatefulWidget {
  const CreateBotScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<CreateBotScreen> createState() => CreateBotScreenState();
}

class CreateBotScreenState extends State<CreateBotScreen> {
  final _nameController = TextEditingController();
  final _descriptionController = TextEditingController();
  String _colorToken = avatarColorTokens.first;
  AvatarShape _shape = AvatarShape.circle;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _nameController.dispose();
    _descriptionController.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Give your bot a name before creating it.');
      return;
    }
    if (_submitting) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final role = await widget.apiClient.createRole(
        name,
        _descriptionController.text.trim(),
        avatarColor: _colorToken,
        avatarShape: _shape.token,
      );
      await widget.apiClient.updateRoleInstructions(
        role.id,
        botCharterTemplate,
      );
      await widget.apiClient.createThread(role.id);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on UnauthorizedError {
      if (!mounted) return;
      Navigator.of(context).pop(false);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Failed to create bot.';
        _submitting = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Create a bot')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: ListView(
          children: [
            Center(
              child: BotAvatar(
                key: const Key('avatar-preview'),
                seed: 'preview',
                avatarColor: _colorToken,
                name: _nameController.text.isEmpty ? '?' : _nameController.text,
                shape: _shape,
                size: 64,
              ),
            ),
            const SizedBox(height: 16),
            TextField(
              key: const Key('bot-name-field'),
              controller: _nameController,
              decoration: const InputDecoration(labelText: 'Name'),
              onChanged: (_) => setState(() {
                if (_error != null) _error = null;
              }),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('bot-description-field'),
              controller: _descriptionController,
              decoration: const InputDecoration(
                labelText: 'Description (optional)',
              ),
              maxLines: 3,
            ),
            const SizedBox(height: 16),
            const Text('Color'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: avatarColorTokens.map((token) {
                final selected = token == _colorToken;
                return GestureDetector(
                  key: Key('color-swatch-$token'),
                  onTap: () => setState(() => _colorToken = token),
                  child: Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      color: avatarColorForToken(token),
                      shape: BoxShape.circle,
                      border: selected
                          ? Border.all(width: 3, color: Colors.black)
                          : null,
                    ),
                  ),
                );
              }).toList(),
            ),
            const SizedBox(height: 16),
            const Text('Shape'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: AvatarShape.values.map((shape) {
                final selected = shape == _shape;
                return ChoiceChip(
                  key: Key('shape-${shape.token}'),
                  label: Text(shape.token),
                  selected: selected,
                  onSelected: (_) => setState(() => _shape = shape),
                );
              }).toList(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                key: const Key('create-bot-error'),
                style: const TextStyle(color: Colors.red),
              ),
            ],
            const SizedBox(height: 24),
            ElevatedButton(
              key: const Key('create-bot-submit'),
              onPressed: _submitting ? null : submit,
              child: Text(_submitting ? 'Creating…' : 'Create bot'),
            ),
          ],
        ),
      ),
    );
  }
}
