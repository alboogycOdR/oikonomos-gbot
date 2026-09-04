import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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

    final container = tester.widget<Container>(find.byType(Container));
    final decoration = container.decoration! as BoxDecoration;
    expect(decoration.color, avatarPalette[3]);
  });
}
