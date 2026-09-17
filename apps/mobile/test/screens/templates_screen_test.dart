import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/templates_screen.dart';

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

void main() {
  testWidgets('shows loading, template rows, and the empty library state',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/templates', 200, [
      {
        'templateId': 'template-1',
        'version': 2,
        'name': 'Concierge',
        'digest': 'digest-1',
      },
    ]);

    await tester
        .pumpWidget(MaterialApp(home: TemplatesScreen(apiClient: client)));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.text('Concierge'), findsOneWidget);
    expect(find.text('Version 2'), findsOneWidget);

    fake.queueJsonFor('GET', '/templates', 200, <Object?>[]);
    await tester.drag(find.byType(ListView), const Offset(0, 300));
    await tester.pumpAndSettle();
    expect(find.text('No templates yet.'), findsOneWidget);
  });

  testWidgets('retries after a template-library error', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor(
        'GET', '/templates', 500, {'error': 'service unavailable'});
    fake.queueJsonFor('GET', '/templates', 200, <Object?>[]);

    await tester
        .pumpWidget(MaterialApp(home: TemplatesScreen(apiClient: client)));
    await tester.pumpAndSettle();
    expect(find.text('service unavailable'), findsOneWidget);
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('No templates yet.'), findsOneWidget);
  });

  testWidgets('installs a template and displays the server grant checklist',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/templates', 200, [
      {
        'templateId': 'template-1',
        'version': 1,
        'name': 'Concierge',
        'digest': 'digest-1',
      },
    ]);
    fake.queueJsonFor('POST', '/templates/template-1/install', 201, {
      'role': {'roleId': 'role-new'},
      'grant_checklist': [
        {
          'capability_id': 'mail.send',
          'requested_max_tier': 'T2_internal',
          'status': 'available',
        },
        {
          'capability_id': 'legacy.connector',
          'requested_max_tier': 'T1',
          'status': 'unknown_capability',
        },
      ],
      'next': 'run one supervised turn before enabling routines',
    });

    await tester
        .pumpWidget(MaterialApp(home: TemplatesScreen(apiClient: client)));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Install'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Install').last);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Template installed'), findsOneWidget);
    expect(find.text('Created role: role-new'), findsOneWidget);
    expect(find.textContaining('mail.send: available'), findsOneWidget);
    expect(find.textContaining('legacy.connector: unknown_capability'),
        findsOneWidget);
    final request = fake.requests.lastWhere(
      (request) => request.url.path == '/templates/template-1/install',
    ) as http.Request;
    expect(jsonDecode(request.body), {'version': 1});
  });
}
