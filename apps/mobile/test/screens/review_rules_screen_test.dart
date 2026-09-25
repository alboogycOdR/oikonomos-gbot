import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/review_rules_screen.dart';

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

Map<String, dynamic> _rule(String id, String capabilityId, {String? by}) => {
      'ruleId': id,
      'capabilityId': capabilityId,
      'enabled': true,
      'createdBy': by,
    };

Map<String, dynamic> _grant(String capabilityId) => {
      'roleId': 'role-1',
      'capabilityId': capabilityId,
      'maxTier': 'T1',
      'constraints': <String, Object?>{},
    };

void main() {
  testWidgets(
      'lists auto-created rules, adds a granted capability, and removes one',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/roles/role-1/review-rules', 200, [
      _rule('auto-1', 'shell.exec', by: 'auto-review'),
    ]);
    fake.queueJsonFor('GET', '/roles/role-1/grants', 200, [
      _grant('shell.exec'),
      _grant('mcp.call'),
    ]);
    fake.queueJsonFor('POST', '/roles/role-1/review-rules', 201,
        _rule('manual-1', 'mcp.call', by: 'manual'));
    fake.queueJsonFor('DELETE', '/roles/role-1/review-rules/auto-1', 204, null);

    await tester.pumpWidget(MaterialApp(
      home: ReviewRulesScreen(apiClient: client, roleId: 'role-1'),
    ));
    await tester.pumpAndSettle();

    expect(find.text('shell.exec'), findsOneWidget);
    expect(find.text('Auto-created by Auto-review'), findsOneWidget);

    await tester.tap(find.byKey(const Key('review-rule-capability-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('mcp.call').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('review-rule-add-button')));
    await tester.pumpAndSettle();

    final create = fake.requests.lastWhere(
      (request) =>
          request.method == 'POST' &&
          request.url.path == '/roles/role-1/review-rules',
    ) as http.Request;
    expect(jsonDecode(create.body), {'capabilityId': 'mcp.call'});
    expect(find.byKey(const Key('review-rule-manual-1')), findsOneWidget);

    await tester.tap(find.byKey(const Key('review-rule-remove-auto-1')));
    await tester.pumpAndSettle();

    expect(
      fake.requests.any((request) =>
          request.method == 'DELETE' &&
          request.url.path == '/roles/role-1/review-rules/auto-1'),
      isTrue,
    );
    expect(find.byKey(const Key('review-rule-auto-1')), findsNothing);
  });
}
