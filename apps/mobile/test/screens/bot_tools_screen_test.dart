import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/screens/bot_tools_screen.dart';

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

Map<String, dynamic> _catalog({bool granted = false}) => {
      'systems': [
        {
          'id': 'gmail',
          'label': 'Gmail',
          'tools': [
            {
              'id': 'gmail.read',
              'label': 'Read mail',
              'description': 'Read messages from the inbox.',
              'defaultTier': 'T0_observe',
              'granted': granted,
              'maxTier': granted ? 'T0_observe' : null,
              'grantable': true,
            },
            {
              'id': 'gmail.send',
              'label': 'Send mail',
              'description': 'Send an email.',
              'defaultTier': 'T3_external',
              'granted': false,
              'maxTier': null,
              'grantable': false,
            },
          ],
        },
        {
          'id': 'workspace',
          'label': 'Workspace',
          'tools': [
            {
              'id': 'workspace.search',
              'label': 'Search workspace',
              'description': 'Search shared documents.',
              'defaultTier': 'T1_draft',
              'granted': false,
              'maxTier': null,
              'grantable': true,
            },
          ],
        },
      ],
    };

void main() {
  Future<void> pumpScreen(WidgetTester tester, ApiClient client) =>
      tester.pumpWidget(MaterialApp(
          home: BotToolsScreen(apiClient: client, roleId: 'role-1')));

  testWidgets('groups tools and grants then revokes through the role routes',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/roles/role-1/tools', 200, _catalog());
    await pumpScreen(tester, client);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('tool-system-gmail')), findsOneWidget);
    expect(find.byKey(const Key('tool-system-workspace')), findsOneWidget);
    expect(find.text('Read mail'), findsOneWidget);
    expect(find.text('Read messages from the inbox.'), findsOneWidget);

    fake.queueJsonFor('POST', '/roles/role-1/grants', 201, {
      'roleId': 'role-1',
      'capabilityId': 'gmail.read',
      'maxTier': 'T0_observe',
      'constraints': {},
    });
    fake.queueJsonFor(
        'GET', '/roles/role-1/tools', 200, _catalog(granted: true));
    await tester.tap(find.byKey(const Key('tool-grant-gmail.read')));
    await tester.pumpAndSettle();

    final grant = fake.requests.lastWhere((request) => request.method == 'POST')
        as http.Request;
    expect(grant.url.path, '/roles/role-1/grants');
    expect(jsonDecode(grant.body),
        {'capabilityId': 'gmail.read', 'maxTier': 'T0_observe'});
    expect(
        tester
            .widget<SwitchListTile>(
                find.byKey(const Key('tool-grant-gmail.read')))
            .value,
        isTrue);

    fake.queueJsonFor('DELETE', '/roles/role-1/grants/gmail.read', 204, null);
    fake.queueJsonFor('GET', '/roles/role-1/tools', 200, _catalog());
    await tester.tap(find.byKey(const Key('tool-grant-gmail.read')));
    await tester.pumpAndSettle();

    expect(
      fake.requests.any((request) =>
          request.method == 'DELETE' &&
          request.url.path == '/roles/role-1/grants/gmail.read'),
      isTrue,
    );
    expect(
        tester
            .widget<SwitchListTile>(
                find.byKey(const Key('tool-grant-gmail.read')))
            .value,
        isFalse);
  });

  testWidgets('shows locked tools without an active switch', (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/roles/role-1/tools', 200, _catalog());
    await pumpScreen(tester, client);
    await tester.pumpAndSettle();

    final locked = tester
        .widget<SwitchListTile>(find.byKey(const Key('tool-grant-gmail.send')));
    expect(locked.onChanged, isNull);
    expect(find.textContaining('Locked — this tool cannot be changed here.'),
        findsOneWidget);
    final requestCount = fake.requests.length;
    await tester.tap(find.byKey(const Key('tool-grant-gmail.send')));
    await tester.pump();
    expect(fake.requests.length, requestCount);
  });

  testWidgets(
      'failed grant keeps the server-confirmed switch state and reports an error',
      (tester) async {
    final fake = FakeHttpClient();
    final client = await _loggedIn(fake);
    fake.queueJsonFor('GET', '/roles/role-1/tools', 200, _catalog());
    fake.queueJsonFor('POST', '/roles/role-1/grants', 500, {'error': 'boom'});
    await pumpScreen(tester, client);
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('tool-grant-gmail.read')));
    await tester.pumpAndSettle();

    expect(
        tester
            .widget<SwitchListTile>(
                find.byKey(const Key('tool-grant-gmail.read')))
            .value,
        isFalse);
    expect(find.text('Could not update this tool.'), findsOneWidget);
  });
}
