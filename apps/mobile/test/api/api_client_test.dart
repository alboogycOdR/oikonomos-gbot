import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/api/exceptions.dart';
import 'package:oikonomos_mobile/api/models.dart';

import '../support/fake_http_client.dart';

void main() {
  group('ApiClient.login', () {
    test('captures the session cookie on success', () async {
      final fake = FakeHttpClient();
      fake.queueJson(
        200,
        {'authenticated': true},
        headers: {
          'set-cookie':
              'control_api_session=abc123; Path=/; HttpOnly; SameSite=Strict',
        },
      );
      final client = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);

      expect(client.isAuthenticated, isFalse);
      await client.login('shared-token');
      expect(client.isAuthenticated, isTrue);
      expect(client.cookieHeaders['cookie'], 'control_api_session=abc123');

      final request = fake.requests.single;
      expect(request.url.path, '/auth/login');
      expect(request.method, 'POST');
    });

    test('throws UnauthorizedError on a 401 and stores nothing', () async {
      final fake = FakeHttpClient();
      fake.queueJson(401, {'error': 'invalid token'});
      final client = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);

      await expectLater(
        () => client.login('bad-token'),
        throwsA(isA<UnauthorizedError>()),
      );
      expect(client.isAuthenticated, isFalse);
    });

    test('throws ApiException with the server message on other failures', () async {
      final fake = FakeHttpClient();
      fake.queueJson(400, {'error': 'malformed request'});
      final client = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);

      await expectLater(
        () => client.login(''),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'malformed request',
          ),
        ),
      );
    });
  });

  group('ApiClient authenticated calls', () {
    Future<ApiClient> loggedIn(FakeHttpClient fake) async {
      fake.queueJson(
        200,
        {'authenticated': true},
        headers: {'set-cookie': 'control_api_session=abc123; Path=/'},
      );
      final client = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);
      await client.login('shared-token');
      return client;
    }

    test('listRoles parses the role list and replays the cookie', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(200, [
        {
          'id': 'role-1',
          'name': 'Concierge',
          'description': 'Front desk',
          'avatarSeed': 'seed-1',
        },
      ]);

      final roles = await client.listRoles();
      expect(roles, hasLength(1));
      expect(roles.single.name, 'Concierge');

      final rolesRequest = fake.requests.last;
      expect(rolesRequest.headers['cookie'], 'control_api_session=abc123');
    });

    test('createRole posts name/description and returns the created role', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(200, {
        'id': 'role-2',
        'name': 'Analyst',
        'description': 'Numbers',
        'avatarSeed': 'seed-2',
      });

      final role = await client.createRole('Analyst', 'Numbers');
      expect(role.id, 'role-2');

      final request = fake.requests.last;
      expect(request.method, 'POST');
      expect(request.url.path, '/roles');
      expect(request, isA<http.Request>());
      final body = jsonDecode((request as http.Request).body) as Map<String, dynamic>;
      expect(body, {'name': 'Analyst', 'description': 'Numbers'});
    });

    test('createThread posts roleId and returns the new thread id', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      // POST /threads returns the raw db Thread row (no botName/
      // avatarSeed/lastMessagePreview) — only `id` is used by callers.
      fake.queueJson(201, {
        'id': 'thread-9',
        'roleId': 'role-2',
        'updatedAt': '2026-09-04T00:03:00Z',
      });

      final threadId = await client.createThread('role-2');
      expect(threadId, 'thread-9');

      final request = fake.requests.last;
      expect(request.method, 'POST');
      expect(request.url.path, '/threads');
      expect(request, isA<http.Request>());
      final body = jsonDecode((request as http.Request).body) as Map<String, dynamic>;
      expect(body, {'roleId': 'role-2'});
    });

    test('listThreads discriminates single vs group threads', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(200, [
        {
          'id': 'thread-1',
          'roleId': 'role-1',
          'botName': 'Concierge',
          'botDescription': 'desk',
          'avatarSeed': 'seed-1',
          'title': null,
          'lastMessagePreview': 'hi',
          'updatedAt': '2026-09-04T00:00:00Z',
        },
        {
          'id': 'thread-2',
          'memberRoleIds': ['role-1', 'role-2'],
          'memberNames': ['Concierge', 'Analyst'],
          'title': 'Group chat',
          'lastMessagePreview': 'hello all',
          'updatedAt': '2026-09-04T00:01:00Z',
        },
      ]);

      final threads = await client.listThreads();
      expect(threads, hasLength(2));
      expect(threads[0], isA<SingleThread>());
      expect(threads[1], isA<GroupThread>());
      expect((threads[1] as GroupThread).memberNames, ['Concierge', 'Analyst']);
    });

    test('listThreadMessages passes the after cursor as a query param', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(200, [
        {
          'id': 'msg-1',
          'threadId': 'thread-1',
          'role': 'user',
          'body': 'hello',
          'runId': null,
          'createdAt': '2026-09-04T00:00:00Z',
        },
      ]);

      final messages = await client.listThreadMessages('thread-1', after: 'msg-0');
      expect(messages, hasLength(1));
      expect(messages.single.body, 'hello');

      final request = fake.requests.last;
      expect(request.url.path, '/threads/thread-1/messages');
      expect(request.url.queryParameters['after'], 'msg-0');
    });

    test('sendThreadMessage posts the body and returns the created message', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(200, {
        'id': 'msg-2',
        'threadId': 'thread-1',
        'role': 'user',
        'body': 'hi there',
        'runId': null,
        'createdAt': '2026-09-04T00:02:00Z',
      });

      final message = await client.sendThreadMessage('thread-1', 'hi there');
      expect(message.body, 'hi there');

      final request = fake.requests.last;
      expect(request.method, 'POST');
      expect(request.url.path, '/threads/thread-1/messages');
    });

    test('a 401 on any authenticated call throws UnauthorizedError', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(401, {'error': 'unauthorized'});

      await expectLater(
        () => client.listRoles(),
        throwsA(isA<UnauthorizedError>()),
      );
    });
  });
}
