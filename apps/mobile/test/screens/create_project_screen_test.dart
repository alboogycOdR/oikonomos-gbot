import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/create_project_screen.dart';

import '../support/fake_http_client.dart';

Future<ApiClient> _loggedIn(FakeHttpClient fake) async {
  fake.queueJson(200, {
    'authenticated': true
  }, headers: {
    'set-cookie': 'control_api_session=abc123; Path=/',
  });
  final client = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);
  await client.login('shared-token');
  return client;
}

List<Map<String, Object?>> _roles(int n) => [
      for (var i = 1; i <= n; i++)
        {
          'id': 'r$i',
          'name': 'Bot $i',
          'description': '',
          'avatarSeed': 's$i',
        },
    ];

Future<void> _fill(WidgetTester tester) async {
  await tester.enterText(find.byKey(const Key('project-name')), 'Launch');
  await tester.enterText(find.byKey(const Key('project-goal')), 'Ship');
  await tester.enterText(find.byKey(const Key('project-done')), 'Shipped');
  await tester.pump();
}

Future<void> _pick(WidgetTester tester, int i) async {
  final finder = find.byKey(Key('project-pick-r$i'));
  await tester.ensureVisible(finder);
  await tester.tap(finder);
  await tester.pump();
}

void main() {
  testWidgets('sends charter, roster and single manager at creation',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/roles', 200, _roles(3));
    fake.queueJsonFor('POST', '/projects', 201, {
      'project': {
        'projectId': 'p1',
        'threadId': 't1',
        'name': 'Launch',
        'goal': 'Ship',
        'doneCriterion': 'Shipped',
        'status': 'active',
        'budgetUsd': null,
        'createdBy': '',
        'createdAt': '',
        'updatedAt': '',
      },
      'roster': [],
    });

    await tester.binding.setSurfaceSize(const Size(600, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
        MaterialApp(home: CreateProjectScreen(apiClient: client)));
    await tester.pumpAndSettle();
    await _fill(tester);
    await tester.enterText(
        find.byKey(const Key('project-boundaries')), 'no spend');
    await tester.enterText(
        find.byKey(const Key('project-check-with-me')), 'deploys');
    await _pick(tester, 1);
    await _pick(tester, 2);
    await tester.tap(find.byKey(const Key('project-manager-r1')));
    await tester.pump();
    // Marking r2 as manager moves the flag: at most one manager.
    await tester.tap(find.byKey(const Key('project-manager-r2')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('project-create-submit')));
    await tester.pumpAndSettle();

    final post = fake.requests
        .whereType<http.Request>()
        .firstWhere((r) => r.method == 'POST' && r.url.path == '/projects');
    final body = jsonDecode(post.body) as Map<String, dynamic>;
    expect(body['boundaries'], 'no spend');
    expect(body['checkWithMeBefore'], 'deploys');
    final roster = body['roster'] as List;
    expect(roster.length, 2);
    expect(roster.where((m) => m['isManager'] == true).length, 1);
    expect(roster.firstWhere((m) => m['isManager'] == true)['roleId'], 'r2');
  });

  testWidgets('blocks a seventh bot client-side', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/roles', 200, _roles(7));

    await tester.binding.setSurfaceSize(const Size(600, 2400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
        MaterialApp(home: CreateProjectScreen(apiClient: client)));
    await tester.pumpAndSettle();
    for (var i = 1; i <= 7; i++) {
      await _pick(tester, i);
    }
    expect(find.text('Bots (6/6) — mark at most one as manager'),
        findsOneWidget);
    expect(find.byKey(const Key('project-create-error')), findsOneWidget);
    expect(
        tester
            .widget<Checkbox>(find.byKey(const Key('project-pick-r7')))
            .value,
        isFalse);
  });

  testWidgets("surfaces the server's own rejection", (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/roles', 200, _roles(2));
    fake.queueJsonFor(
        'POST', '/projects', 400, {'error': 'roster must have 2 members'});

    await tester.binding.setSurfaceSize(const Size(600, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
        MaterialApp(home: CreateProjectScreen(apiClient: client)));
    await tester.pumpAndSettle();
    await _fill(tester);
    await _pick(tester, 1);
    await tester.tap(find.byKey(const Key('project-create-submit')));
    await tester.pumpAndSettle();
    expect(find.text('roster must have 2 members'), findsOneWidget);
    expect(find.byType(CreateProjectScreen), findsOneWidget);
  });
}
