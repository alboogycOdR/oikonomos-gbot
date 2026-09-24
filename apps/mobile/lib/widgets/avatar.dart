import 'dart:math' as math;

import 'package:flutter/material.dart';

/// TASK-147 (Mobile Wave 1b) — deterministic initials-on-color avatar,
/// mirroring `apps/dashboard/src/components/chat/Avatar.tsx`'s palette
/// and hash function exactly so a bot's avatar looks the same on web and
/// mobile for the same `avatarSeed`.
const Map<String, Color> avatarColors = {
  'red': Color(0xFFEF4444),
  'orange': Color(0xFFF97316),
  'amber': Color(0xFFF59E0B),
  'yellow': Color(0xFFEAB308),
  'lime': Color(0xFF84CC16),
  'green': Color(0xFF22C55E),
  'teal': Color(0xFF14B8A6),
  'cyan': Color(0xFF06B6D4),
  'blue': Color(0xFF3B82F6),
  'indigo': Color(0xFF6366F1),
  'violet': Color(0xFF8B5CF6),
  'pink': Color(0xFFEC4899),
};

const List<Color> avatarPalette = [
  Color(0xFFEF4444),
  Color(0xFFF97316),
  Color(0xFFF59E0B),
  Color(0xFFEAB308),
  Color(0xFF84CC16),
  Color(0xFF22C55E),
  Color(0xFF14B8A6),
  Color(0xFF06B6D4),
  Color(0xFF3B82F6),
  Color(0xFF6366F1),
  Color(0xFF8B5CF6),
  Color(0xFFEC4899),
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

enum AvatarShape {
  circle,
  square,
  rounded,
  hexagon,
  diamond,
  star,
  triangle,
  teardrop
}

AvatarShape? avatarShapeForToken(String? token) => switch (token) {
      'circle' => AvatarShape.circle,
      'square' => AvatarShape.square,
      'rounded' => AvatarShape.rounded,
      'hexagon' => AvatarShape.hexagon,
      'diamond' => AvatarShape.diamond,
      'star' => AvatarShape.star,
      'triangle' => AvatarShape.triangle,
      'teardrop' => AvatarShape.teardrop,
      _ => null,
    };

extension AvatarShapeToken on AvatarShape {
  String get token => name;
}

Color? avatarColorForToken(String? token) => avatarColors[token];

class BotAvatar extends StatelessWidget {
  const BotAvatar({
    super.key,
    required this.seed,
    required this.name,
    this.shape,
    this.color,
    this.avatarColor,
    this.avatarShape,
    this.size = 40,
  });

  final String seed;
  final String name;
  final AvatarShape? shape;

  /// Overrides the seed-derived color — used only by the create-bot
  /// picker's live preview, where the user is choosing a swatch directly
  /// rather than viewing an already-assigned bot.
  final Color? color;
  final String? avatarColor;
  final String? avatarShape;
  final double size;

  @override
  Widget build(BuildContext context) {
    final resolvedColor =
        color ?? avatarColorForToken(avatarColor) ?? colorForSeed(seed);
    final resolvedShape =
        avatarShapeForToken(avatarShape) ?? shape ?? AvatarShape.circle;
    return Semantics(
      label: '$name avatar',
      container: true,
      child: ExcludeSemantics(
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: resolvedShape == AvatarShape.circle
                ? BoxShape.circle
                : BoxShape.rectangle,
            borderRadius: resolvedShape == AvatarShape.rounded
                ? BorderRadius.circular(size * 0.25)
                : null,
          ),
          child: ClipPath(
            clipper: _AvatarShapeClipper(resolvedShape),
            child: Container(
              color: resolvedColor,
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
        ),
      ),
    );
  }
}

class _AvatarShapeClipper extends CustomClipper<Path> {
  const _AvatarShapeClipper(this.shape);
  final AvatarShape shape;

  @override
  Path getClip(Size size) {
    final w = size.width;
    final h = size.height;
    if (shape == AvatarShape.circle) return Path()..addOval(Offset.zero & size);
    if (shape == AvatarShape.rounded) {
      return Path()
        ..addRRect(RRect.fromRectAndRadius(
            Offset.zero & size, Radius.circular(w * .25)));
    }
    if (shape == AvatarShape.square) return Path()..addRect(Offset.zero & size);
    if (shape == AvatarShape.hexagon) {
      return Path()
        ..moveTo(w * .25, 0)
        ..lineTo(w * .75, 0)
        ..lineTo(w, h * .5)
        ..lineTo(w * .75, h)
        ..lineTo(w * .25, h)
        ..lineTo(0, h * .5)
        ..close();
    }
    if (shape == AvatarShape.diamond) {
      return Path()
        ..moveTo(w * .5, 0)
        ..lineTo(w, h * .5)
        ..lineTo(w * .5, h)
        ..lineTo(0, h * .5)
        ..close();
    }
    if (shape == AvatarShape.triangle) {
      return Path()
        ..moveTo(w * .5, 0)
        ..lineTo(w, h)
        ..lineTo(0, h)
        ..close();
    }
    if (shape == AvatarShape.teardrop) {
      return Path()
        ..moveTo(w * .5, 0)
        ..cubicTo(w, h * .35, w, h, w * .5, h)
        ..cubicTo(0, h, 0, h * .35, w * .5, 0)
        ..close();
    }
    return _starPath(w, h);
  }

  Path _starPath(double w, double h) {
    final path = Path();
    for (var i = 0; i < 10; i++) {
      final angle = -1.57079632679 + i * 0.62831853072;
      final radius = i.isEven ? w * .5 : w * .22;
      final point = Offset(
          w * .5 + radius * math.cos(angle), h * .5 + radius * math.sin(angle));
      i == 0
          ? path.moveTo(point.dx, point.dy)
          : path.lineTo(point.dx, point.dy);
    }
    return path..close();
  }

  @override
  bool shouldReclip(covariant _AvatarShapeClipper oldClipper) =>
      oldClipper.shape != shape;
}
