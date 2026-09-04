import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/create_bot_screen.dart';

import '../support/fake_http_client.dart';

Future<ApiClient> _loggedIn(FakeHttpClient fake) async {
  fake.queueJson(
    200,
    {'authenticated': true},
    headers: {'set-cookie': 'control_api_session=abc123; Path=/'},
  );
  final client = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);
  await client.login('shared-token');
  return client;
}

void main() {
  testWidgets('empty name shows a validation error and does not submit', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);

    await tester.pumpWidget(
      MaterialApp(home: CreateBotScreen(apiClient: client)),
    );

    await tester.tap(find.byKey(const Key('create-bot-submit')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('create-bot-error')), findsOneWidget);
    // No POST /roles was ever sent.
    expect(fake.requests, hasLength(1)); // only the login call
  });

  testWidgets(
    'creating a bot posts /roles then /threads and pops with success',
    (tester) async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      fake.queueJson(201, {
        'id': 'role-new',
        'name': 'Research Assistant',
        'description': 'Helps with research',
        'avatarSeed': 'role-new',
      });
      fake.queueJson(201, {
        'id': 'thread-new',
        'roleId': 'role-new',
        'updatedAt': '2026-09-04T00:00:00Z',
      });

      bool? poppedWith;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () async {
                poppedWith = await Navigator.of(context).push<bool>(
                  MaterialPageRoute(
                    builder: (_) => CreateBotScreen(apiClient: client),
                  ),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('bot-name-field')),
        'Research Assistant',
      );
      await tester.tap(find.byKey(const Key('color-swatch-2')));
      await tester.tap(find.byKey(const Key('shape-roundedSquare')));
      await tester.tap(find.byKey(const Key('create-bot-submit')));
      await tester.pumpAndSettle();

      expect(poppedWith, isTrue);

      final rolesRequest = fake.requests.firstWhere(
        (r) => r.url.path == '/roles',
      );
      expect(rolesRequest.method, 'POST');
      final threadsRequest = fake.requests.firstWhere(
        (r) => r.url.path == '/threads',
      );
      expect(threadsRequest.method, 'POST');
    },
  );

  testWidgets('a create failure shows an error and does not pop', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJson(400, {'error': 'name must not be empty.'});

    bool pushed = true;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () async {
              final result = await Navigator.of(context).push<bool>(
                MaterialPageRoute(
                  builder: (_) => CreateBotScreen(apiClient: client),
                ),
              );
              pushed = result == null; // still on the route (no pop yet)
            },
            child: const Text('open'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('bot-name-field')),
      'Research Assistant',
    );
    await tester.tap(find.byKey(const Key('create-bot-submit')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('create-bot-error')), findsOneWidget);
    expect(find.byType(CreateBotScreen), findsOneWidget);
    expect(pushed, isTrue);
  });
}
