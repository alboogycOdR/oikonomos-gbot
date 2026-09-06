import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/api/models.dart';
import 'package:oikonomos_mobile/screens/routine_detail_screen.dart';

import '../support/fake_http_client.dart';

const _routine = Routine(
  id: 'routine-1',
  name: 'Daily',
  schedule: '0 8 * * *',
  lastFireAt: null,
  nextFireAt: null,
  paused: false,
);

Future<ApiClient> _client(FakeHttpClient fake) async {
  fake.queueJson(200, {'authenticated': true},
      headers: {'set-cookie': 'control_api_session=x; Path=/'});
  final client = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);
  await client.login('token');
  return client;
}

void main() {
  testWidgets(
      'pause control uses the real pause endpoint and updates its label',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _client(fake);
    fake.queueJsonFor('GET', '/tasks', 200, {'tasks': <Object?>[]});
    fake.queueJsonFor('POST', '/routines/routine-1/pause', 200, {
      'routineId': 'routine-1',
      'name': 'Daily',
      'schedule': '0 8 * * *',
      'lastFireAt': null,
      'nextFireAt': null,
      'paused': true,
    });

    await tester.pumpWidget(MaterialApp(
        home: RoutineDetailScreen(apiClient: client, routine: _routine)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('routine-pause-resume')));
    await tester.pumpAndSettle();

    final request = fake.requests.last as http.Request;
    expect(request.method, 'POST');
    expect(request.url.path, '/routines/routine-1/pause');
    expect(find.text('Resume routine'), findsOneWidget);
  });

  testWidgets(
      'test run shows the exact warning and only dispatches after confirmation',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _client(fake);
    fake.queueJsonFor('GET', '/tasks', 200, {'tasks': <Object?>[]});
    fake.queueJsonFor('POST', '/routines/routine-1/test-run', 202, {
      'routine': {
        'routineId': 'routine-1',
        'name': 'Daily',
        'schedule': '0 8 * * *',
        'lastFireAt': null,
        'nextFireAt': null,
        'paused': false
      },
      'warning': 'test run performs real work',
    });
    await tester.pumpWidget(MaterialApp(
        home: RoutineDetailScreen(apiClient: client, routine: _routine)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('routine-test-run')));
    await tester.pumpAndSettle();
    expect(find.text('test run performs real work'), findsOneWidget);
    expect(
        fake.requests
            .where((request) => request.url.path.endsWith('/test-run')),
        isEmpty);
    await tester.tap(find.text('Run test'));
    await tester.pumpAndSettle();
    final request = fake.requests.last as http.Request;
    expect(request.method, 'POST');
    expect(request.url.path, '/routines/routine-1/test-run');
  });
}
