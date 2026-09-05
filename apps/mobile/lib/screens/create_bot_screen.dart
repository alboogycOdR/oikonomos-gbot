import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
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
/// The reference screenshots show a 12-swatch/8-shape avatar grid; this
/// screen ships the reasonable subset [avatarPalette] (6 colors, already
/// shared with `BotAvatar`/the web `Avatar.tsx`) x 2 shapes, noted here
/// as the deliberate scoping choice. More importantly: `POST /roles`
/// derives `avatarSeed` from the server-generated `roleId`
/// (`serializeRole` in app.ts) and accepts no avatar field at all, so
/// whatever the user picks here can only ever be a **preview** of what
/// an initials-on-color avatar looks like — it is never sent to the
/// server, and the roster reload afterwards shows the real
/// (roleId-seeded) color/shape instead. The preview label below makes
/// that explicit so it isn't mistaken for a persisted choice.
class CreateBotScreen extends StatefulWidget {
  const CreateBotScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<CreateBotScreen> createState() => CreateBotScreenState();
}

class CreateBotScreenState extends State<CreateBotScreen> {
  final _nameController = TextEditingController();
  final _descriptionController = TextEditingController();
  int _colorIndex = 0;
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
                color: avatarPalette[_colorIndex],
                name: _nameController.text.isEmpty ? '?' : _nameController.text,
                shape: _shape,
                size: 64,
              ),
            ),
            const SizedBox(height: 8),
            const Center(
              child: Text(
                'Preview only — the server assigns the real avatar color.',
                style: TextStyle(fontSize: 11, color: Colors.grey),
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
              children: List.generate(avatarPalette.length, (index) {
                final selected = index == _colorIndex;
                return GestureDetector(
                  key: Key('color-swatch-$index'),
                  onTap: () => setState(() => _colorIndex = index),
                  child: Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      color: avatarPalette[index],
                      shape: BoxShape.circle,
                      border: selected
                          ? Border.all(width: 3, color: Colors.black)
                          : null,
                    ),
                  ),
                );
              }),
            ),
            const SizedBox(height: 16),
            const Text('Shape'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: AvatarShape.values.map((shape) {
                final selected = shape == _shape;
                return ChoiceChip(
                  key: Key('shape-${shape.name}'),
                  label: Text(shape.name),
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
