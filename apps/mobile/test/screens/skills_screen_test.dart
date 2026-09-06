import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/skills_screen.dart';

import '../support/fake_http_client.dart';

Future<ApiClient> _client(FakeHttpClient fake) async {
  fake.queueJson(200, {'authenticated': true},
      headers: {'set-cookie': 'session=ok'});
  final client = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);
  await client.login('token');
  return client;
}

Map<String, dynamic> _skill(String id, String name) => {
      'skillId': id,
      'name': name,
      'description': 'Useful procedure',
      'whenToUse': 'When asked',
      'body': '# Steps',
      'approvals': ['shell.execute'],
      'status': 'active',
    };

void main() {
  testWidgets('lists, creates, and edits skills through the API client',
      (tester) async {
    tester.view.physicalSize = const Size(800, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final fake = FakeHttpClient();
    final client = await _client(fake);
    fake.queueJson(200, [_skill('skill-1', 'draft')]);
    await tester.pumpWidget(MaterialApp(home: SkillsScreen(apiClient: client)));
    await tester.pumpAndSettle();
    expect(find.text('/draft'), findsOneWidget);

    fake.queueJson(201, _skill('skill-2', 'review'));
    fake.queueJson(
        200, [_skill('skill-1', 'draft'), _skill('skill-2', 'review')]);
    await tester.tap(find.byKey(const Key('create-skill-button')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('skill-name-field')), 'review');
    await tester.enterText(
        find.byKey(const Key('skill-description-field')), 'Review a document');
    await tester.enterText(
        find.byKey(const Key('skill-body-field')), '# Review');
    await tester.tap(find.byKey(const Key('skill-save-button')));
    await tester.pumpAndSettle();
    final create = fake.requests.whereType<http.Request>().lastWhere(
        (request) => request.method == 'POST' && request.url.path == '/skills');
    expect(jsonDecode(create.body), containsPair('name', 'review'));
    expect(find.text('/review'), findsOneWidget);

    fake.queueJson(200, _skill('skill-1', 'draft'));
    fake.queueJson(200, [_skill('skill-1', 'draft')]);
    await tester.tap(find.byKey(const Key('skill-tile-skill-1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('skill-description-field')),
        'Updated description');
    await tester.tap(find.byKey(const Key('skill-save-button')));
    await tester.pumpAndSettle();
    final update = fake.requests.whereType<http.Request>().lastWhere(
        (request) =>
            request.method == 'PATCH' && request.url.path == '/skills/skill-1');
    expect(jsonDecode(update.body),
        containsPair('description', 'Updated description'));
  });
}
