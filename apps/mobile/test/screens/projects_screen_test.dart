import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/projects_screen.dart';

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

Map<String, Object?> _project(String id, String name) => {
      'projectId': id,
      'threadId': 't-$id',
      'name': name,
      'goal': 'ship it',
      'doneCriterion': 'shipped',
      'status': 'active',
      'budgetUsd': null,
      'createdBy': 'human:x',
      'createdAt': '',
      'updatedAt': '',
    };

void main() {
  testWidgets('shows loading then real projects', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/projects', 200, [_project('p1', 'Launch')]);

    await tester.pumpWidget(MaterialApp(home: ProjectsScreen(apiClient: client)));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.text('Launch'), findsOneWidget);
    expect(find.text('ship it'), findsOneWidget);
  });

  testWidgets('shows the empty state', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/projects', 200, []);

    await tester.pumpWidget(MaterialApp(home: ProjectsScreen(apiClient: client)));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('projects-empty')), findsOneWidget);
  });

  testWidgets('shows the error state and retries', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/projects', 500, {'error': 'boom'});
    fake.queueJsonFor('GET', '/projects', 200, [_project('p1', 'Launch')]);

    await tester.pumpWidget(MaterialApp(home: ProjectsScreen(apiClient: client)));
    await tester.pumpAndSettle();
    expect(find.text('boom'), findsOneWidget);
    await tester.tap(find.byKey(const Key('projects-retry')));
    await tester.pumpAndSettle();
    expect(find.text('Launch'), findsOneWidget);
  });

  testWidgets('tapping a project uses detailBuilder', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/projects', 200, [_project('p1', 'Launch')]);

    await tester.pumpWidget(
      MaterialApp(
        home: ProjectsScreen(
          apiClient: client,
          detailBuilder: (_, p) => Scaffold(body: Text('detail ${p.projectId}')),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('project-tile-p1')));
    await tester.pumpAndSettle();
    expect(find.text('detail p1'), findsOneWidget);
  });
}
