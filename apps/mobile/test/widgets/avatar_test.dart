import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/models.dart';
import 'package:oikonomos_mobile/widgets/avatar.dart';

void main() {
  group('avatar helpers', () {
    test('colorForSeed is deterministic for the same seed', () {
      expect(colorForSeed('role-1'), colorForSeed('role-1'));
    });

    test('initialsOf uses two words\' first letters', () {
      expect(initialsOf('Research Assistant'), 'RA');
    });

    test('initialsOf falls back to first two letters for a single word', () {
      expect(initialsOf('Concierge'), 'CO');
    });

    test('initialsOf returns ? for empty input', () {
      expect(initialsOf('   '), '?');
    });
  });

  testWidgets('BotAvatar renders initials and an accessible label', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(
      const MaterialApp(
        home: BotAvatar(seed: 'seed-1', name: 'Concierge'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('CO'), findsOneWidget);
    expect(find.bySemanticsLabel('Concierge avatar'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('BotAvatar color override wins over the seed-derived color', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: BotAvatar(
          seed: 'seed-1',
          name: 'Concierge',
          color: avatarPalette[3],
        ),
      ),
    );

    final container = tester.widget<Container>(
      find.descendant(
        of: find.byType(ClipPath),
        matching: find.byType(Container),
      ),
    );
    expect(container.color, avatarPalette[3]);
  });

  testWidgets('saved tokens render their selected color and shape',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: BotAvatar(
          seed: 'seed-1',
          name: 'Concierge',
          avatarColor: 'violet',
          avatarShape: 'hexagon',
        ),
      ),
    );
    final colored = tester.widget<Container>(
      find.descendant(
          of: find.byType(ClipPath), matching: find.byType(Container)),
    );
    expect(colored.color, avatarColorForToken('violet'));
    expect(tester.widget<ClipPath>(find.byType(ClipPath)).clipper, isNotNull);
  });

  test('role and thread avatar parsing accepts valid tokens and falls back',
      () {
    final role = Role.fromJson({
      'id': 'role-1',
      'name': 'Bot',
      'description': '',
      'avatarSeed': 'role-1',
      'avatarColor': 'pink',
      'avatarShape': 'star',
    });
    expect(role.avatarColor, 'pink');
    expect(role.avatarShape, 'star');

    final legacy = Role.fromJson({
      'id': 'role-2',
      'name': 'Legacy',
      'description': '',
      'avatarSeed': 'role-2',
      'avatarColor': 'not-a-color',
      'avatarShape': 4,
    });
    expect(legacy.avatarColor, isNull);
    expect(legacy.avatarShape, isNull);

    final thread = SingleThread.fromJson({
      'id': 'thread-1',
      'roleId': 'role-1',
      'botName': 'Bot',
      'botDescription': '',
      'avatarSeed': 'role-1',
      'updatedAt': '2026-01-01T00:00:00Z',
      'avatarColor': 'unknown',
      'avatarShape': 'triangle',
    });
    expect(thread.avatarColor, isNull);
    expect(thread.avatarShape, 'triangle');
  });
}
