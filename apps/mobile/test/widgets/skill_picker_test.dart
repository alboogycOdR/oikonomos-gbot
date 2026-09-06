import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/widgets/skill_picker.dart';

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
      'description': '$name description',
      'body': '# $name',
      'approvals': [],
      'status': 'active',
    };

void main() {
  testWidgets(
      'lists only the enabled-skills API response and returns selection',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _client(fake);
    fake.queueJsonFor('GET', '/roles/role-1/skills', 200,
        [_skill('skill-enabled', 'summarize')]);
    String? selected;
    await tester.pumpWidget(MaterialApp(
        home: Builder(
            builder: (context) => ElevatedButton(
                onPressed: () async {
                  final skill = await showModalBottomSheet(
                    context: context,
                    builder: (_) =>
                        SkillPicker(apiClient: client, roleId: 'role-1'),
                  );
                  selected = skill?.name as String?;
                },
                child: const Text('open')))));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('/summarize'), findsOneWidget);
    expect(find.text('/not-enabled'), findsNothing);
    await tester.tap(find.byKey(const Key('skill-picker-skill-enabled')));
    await tester.pumpAndSettle();
    expect(selected, 'summarize');
    expect(fake.requests.last.url.path, '/roles/role-1/skills');
  });
}
