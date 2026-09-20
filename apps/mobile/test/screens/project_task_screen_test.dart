import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/api/models.dart';
import 'package:oikonomos_mobile/screens/project_task_screen.dart';

import '../support/fake_http_client.dart';

Future<ApiClient> _loggedIn(FakeHttpClient fake) async {
  fake.queueJson(
    200,
    {'authenticated': true},
    headers: {'set-cookie': 'control_api_session=x; Path=/'},
  );
  final client = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);
  await client.login('token');
  return client;
}

ProjectTask _task({String state = 'doing'}) => ProjectTask(
      taskId: 't1',
      projectId: 'p1',
      title: 'Implement board',
      description: 'Details',
      ownerRoleId: 'r1',
      state: state,
      blockedReason: null,
      doneCriterion: null,
      createdBy: '',
      createdAt: '',
      updatedAt: '',
    );

Map<String, Object?> _updated(String state, {String? reason}) => {
      'taskId': 't1',
      'projectId': 'p1',
      'title': 'Implement board',
      'description': 'Details',
      'ownerRoleId': 'r1',
      'state': state,
      'blockedReason': reason,
      'doneCriterion': null,
      'createdBy': '',
      'createdAt': '',
      'updatedAt': '',
    };

void main() {
  testWidgets('requires a reason before blocked and sends it to the server', (
    tester,
  ) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/projects/p1/artifacts', 200, []);
    fake.queueJsonFor(
      'PATCH',
      '/projects/p1/tasks/t1',
      200,
      _updated('blocked', reason: 'Waiting for approval'),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: ProjectTaskScreen(
          apiClient: client,
          projectId: 'p1',
          task: _task(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('transition-blocked')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('blocked-reason-input')),
      'Waiting for approval',
    );
    await tester.tap(find.byKey(const Key('blocked-reason-submit')));
    await tester.pumpAndSettle();
    expect(find.text('State: blocked'), findsOneWidget);
    final request = fake.requests.lastWhere(
      (r) => r.url.path == '/projects/p1/tasks/t1',
    ) as http.Request;
    expect(jsonDecode(request.body), {
      'state': 'blocked',
      'blockedReason': 'Waiting for approval',
    });
  });

  testWidgets('surfaces a transition refusal verbatim', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/projects/p1/artifacts', 200, []);
    fake.queueJsonFor('PATCH', '/projects/p1/tasks/t1', 409, {
      'error': 'transition is not allowed',
    });
    await tester.pumpWidget(
      MaterialApp(
        home: ProjectTaskScreen(
          apiClient: client,
          projectId: 'p1',
          task: _task(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('transition-review')));
    await tester.pumpAndSettle();
    expect(find.text('transition is not allowed'), findsOneWidget);
  });
}
