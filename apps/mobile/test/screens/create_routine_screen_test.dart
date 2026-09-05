import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/create_routine_screen.dart';

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
  testWidgets('blocks submission with an empty name or schedule', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);

    await tester.pumpWidget(
      MaterialApp(
        home: CreateRoutineScreen(apiClient: client, roleId: 'role-1'),
      ),
    );

    await tester.tap(find.byKey(const Key('create-routine-submit')));
    await tester.pump();
    expect(
      find.text('Give the routine a name before creating it.'),
      findsOneWidget,
    );
    // No request fired beyond the login call already queued/consumed.
    expect(fake.requests, hasLength(1));

    await tester.enterText(
      find.byKey(const Key('routine-name-field')),
      'Daily briefing',
    );
    await tester.tap(find.byKey(const Key('create-routine-submit')));
    await tester.pump();
    expect(
      find.text('A schedule (cron expression) is required.'),
      findsOneWidget,
    );
    expect(fake.requests, hasLength(1));
  });

  testWidgets('surfaces a server validation error visibly', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);

    await tester.pumpWidget(
      MaterialApp(
        home: CreateRoutineScreen(apiClient: client, roleId: 'role-1'),
      ),
    );

    await tester.enterText(
      find.byKey(const Key('routine-name-field')),
      'Bad cron routine',
    );
    await tester.enterText(
      find.byKey(const Key('routine-schedule-field')),
      'not-a-cron',
    );

    fake.queueJson(400, {
      'error': 'schedule must be a valid 5-field cron expression.',
    });

    await tester.tap(find.byKey(const Key('create-routine-submit')));
    await tester.pumpAndSettle();

    expect(
      find.text('schedule must be a valid 5-field cron expression.'),
      findsOneWidget,
    );
    // The screen stayed put — no pop happened on failure.
    expect(find.byKey(const Key('routine-name-field')), findsOneWidget);
  });

  testWidgets('omits the goal field when left empty and pops true on success', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: ElevatedButton(
              onPressed: () async {
                final result = await Navigator.of(context).push<bool>(
                  MaterialPageRoute<bool>(
                    builder: (_) => CreateRoutineScreen(
                      apiClient: client,
                      roleId: 'role-1',
                    ),
                  ),
                );
                // ignore: use_build_context_synchronously
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('result:$result')),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('routine-name-field')),
      'No-goal routine',
    );
    await tester.enterText(
      find.byKey(const Key('routine-schedule-field')),
      '0 9 * * *',
    );

    fake.queueJson(201, {
      'routineId': 'routine-9',
      'name': 'No-goal routine',
      'schedule': '0 9 * * *',
      'lastFireAt': null,
      'nextFireAt': null,
    });

    await tester.tap(find.byKey(const Key('create-routine-submit')));
    await tester.pumpAndSettle();

    expect(find.text('result:true'), findsOneWidget);
    final body = fake.requests.last;
    expect(body.method, 'POST');
  });
}
