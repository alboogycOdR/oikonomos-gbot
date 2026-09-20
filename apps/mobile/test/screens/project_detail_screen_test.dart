import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/project_detail_screen.dart';

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

Map<String, Object?> _project() => {
      'projectId': 'p1',
      'threadId': 't1',
      'name': 'Launch',
      'goal': 'Ship it',
      'doneCriterion': 'Customers can use it',
      'status': 'active',
      'budgetUsd': 10,
      'createdBy': 'human:x',
      'createdAt': '',
      'updatedAt': '',
    };

Map<String, Object?> _artifact(String id, String label, {String? taskId}) => {
      'artifactId': id,
      'projectId': 'p1',
      'taskId': taskId,
      'kind': 'workspace_file',
      'ref': '/oikonomos/workspace/projects/p1/$label',
      'sha256': null,
      'byteSize': 4,
      'producedByRoleId': 'r1',
      'producedByRunId': null,
      'label': label,
      'createdAt': '',
    };

void _queueWorkspace(FakeHttpClient fake, {bool empty = false}) {
  fake.queueJsonFor('GET', '/projects/p1', 200, {
    ..._project(),
    'charter': {'boundaries': 'No production writes'},
    'roster': [
      {'roleId': 'r1', 'isManager': true, 'responsibility': 'Lead'},
    ],
    'board': {'doing': 1, 'blocked': 1},
    'latestStatusArtifact': empty ? null : _artifact('status', 'STATUS.md'),
    'spend': {'usd': 1.5},
  });
  fake.queueJsonFor(
    'GET',
    '/projects/p1/tasks',
    200,
    empty
        ? []
        : [
            {
              'taskId': 'doing',
              'projectId': 'p1',
              'title': 'Build',
              'description': '',
              'ownerRoleId': 'r1',
              'state': 'doing',
              'blockedReason': null,
              'doneCriterion': null,
              'createdBy': '',
              'createdAt': '',
              'updatedAt': '',
            },
            {
              'taskId': 'blocked',
              'projectId': 'p1',
              'title': 'Wait for API',
              'description': '',
              'ownerRoleId': 'r1',
              'state': 'blocked',
              'blockedReason': 'API credentials are missing',
              'doneCriterion': null,
              'createdBy': '',
              'createdAt': '',
              'updatedAt': '',
            },
          ],
  );
  fake.queueJsonFor(
    'GET',
    '/projects/p1/artifacts',
    200,
    empty ? [] : [_artifact('a1', 'report.md', taskId: 'doing')],
  );
  fake.queueJsonFor(
    'GET',
    '/projects/p1/decisions',
    200,
    empty
        ? []
        : [
            {
              'decisionId': 'd1',
              'projectId': 'p1',
              'taskId': null,
              'kind': 'human_decision',
              'approvalId': null,
              'summary': 'Ship mobile first',
              'actor': 'human:x',
              'createdAt': '',
            },
          ],
  );
}

void main() {
  testWidgets(
    'renders the visible blocked board, register, decision log and status',
    (tester) async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      _queueWorkspace(fake);

      await tester.pumpWidget(
        MaterialApp(
          home: ProjectDetailScreen(apiClient: client, projectId: 'p1'),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.pumpAndSettle();

      expect(find.text('Launch'), findsOneWidget);
      expect(find.text('Manager'), findsOneWidget);
      expect(find.byKey(const Key('board-state-blocked')), findsOneWidget);
      expect(find.text('Blocked: API credentials are missing'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('report.md'), 250);
      expect(find.text('report.md'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Ship mobile first'), 250);
      expect(find.text('Ship mobile first'), findsOneWidget);
      expect(find.byKey(const Key('latest-status-artifact')), findsOneWidget);
    },
  );

  testWidgets('renders empty artifact, decision and status states', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    _queueWorkspace(fake, empty: true);
    await tester.pumpWidget(
      MaterialApp(
        home: ProjectDetailScreen(apiClient: client, projectId: 'p1'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.byKey(const Key('artifacts-empty')),
      250,
    );
    expect(find.byKey(const Key('artifacts-empty')), findsOneWidget);
    await tester.scrollUntilVisible(
      find.byKey(const Key('decisions-empty')),
      250,
    );
    expect(find.byKey(const Key('decisions-empty')), findsOneWidget);
    await tester.scrollUntilVisible(find.byKey(const Key('status-empty')), 250);
    expect(find.byKey(const Key('status-empty')), findsOneWidget);
  });

  testWidgets('surfaces a server error verbatim and retries', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/projects/p1', 500, {
      'error': 'project unavailable',
    });
    _queueWorkspace(fake, empty: true);
    _queueWorkspace(fake, empty: true);
    await tester.pumpWidget(
      MaterialApp(
        home: ProjectDetailScreen(apiClient: client, projectId: 'p1'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('project unavailable'), findsOneWidget);
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Launch'), findsOneWidget);
  });
}
