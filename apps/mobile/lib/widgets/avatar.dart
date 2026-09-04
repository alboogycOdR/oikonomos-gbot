import 'package:flutter/material.dart';

/// TASK-147 (Mobile Wave 1b) — deterministic initials-on-color avatar,
/// mirroring `apps/dashboard/src/components/chat/Avatar.tsx`'s palette
/// and hash function exactly so a bot's avatar looks the same on web and
/// mobile for the same `avatarSeed`.
const List<Color> avatarPalette = [
  Color(0xFF2563EB),
  Color(0xFF7C3AED),
  Color(0xFF059669),
  Color(0xFFD97706),
  Color(0xFFDC2626),
  Color(0xFF0891B2),
];

/// Same `hash = hash * 31 + charCode` rolling hash as the web `Avatar.tsx`,
/// masked to 32 bits so results agree across the two runtimes.
int hashSeed(String seed) {
  var hash = 0;
  for (final codeUnit in seed.codeUnits) {
    hash = (hash * 31 + codeUnit) & 0xFFFFFFFF;
  }
  return hash;
}

Color colorForSeed(String seed) =>
    avatarPalette[hashSeed(seed) % avatarPalette.length];

String initialsOf(String name) {
  final parts = name
      .trim()
      .split(RegExp(r'\s+'))
      .where((part) => part.isNotEmpty)
      .toList();
  if (parts.isEmpty) return '?';
  if (parts.length == 1) {
    final first = parts.first;
    return first.substring(0, first.length >= 2 ? 2 : 1).toUpperCase();
  }
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/// The reference screenshots' avatar picker is a 12-swatch/8-shape grid;
/// [AvatarShape] ships the reasonable subset this task scopes to (two
/// shapes) rather than inventing a grid the server has nowhere to persist
/// — see `CreateBotScreen`'s own note on why the shape/color choice there
/// is preview-only.
enum AvatarShape { circle, roundedSquare }

class BotAvatar extends StatelessWidget {
  const BotAvatar({
    super.key,
    required this.seed,
    required this.name,
    this.shape = AvatarShape.circle,
    this.color,
    this.size = 40,
  });

  final String seed;
  final String name;
  final AvatarShape shape;

  /// Overrides the seed-derived color — used only by the create-bot
  /// picker's live preview, where the user is choosing a swatch directly
  /// rather than viewing an already-assigned bot.
  final Color? color;
  final double size;

  @override
  Widget build(BuildContext context) {
    final resolvedColor = color ?? colorForSeed(seed);
    return Semantics(
      label: '$name avatar',
      container: true,
      child: ExcludeSemantics(
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: resolvedColor,
            shape: shape == AvatarShape.circle
                ? BoxShape.circle
                : BoxShape.rectangle,
            borderRadius: shape == AvatarShape.roundedSquare
                ? BorderRadius.circular(size * 0.25)
                : null,
          ),
          alignment: Alignment.center,
          child: Text(
            initialsOf(name),
            style: TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.w600,
              fontSize: size * 0.35,
            ),
          ),
        ),
      ),
    );
  }
}
