import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/api/exceptions.dart';
import 'package:oikonomos_mobile/api/models.dart';

import '../support/fake_http_client.dart';

Future<ApiClient> _loggedInForTemplates(FakeHttpClient fake) async {
  fake.queueJson(
    200,
    {'authenticated': true},
    headers: {'set-cookie': 'control_api_session=abc123; Path=/'},
  );
  final client = ApiClient(baseUrl: 'http://localhost:3000', httpClient: fake);
  await client.login('shared-token');
  return client;
}

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
      final client = ApiClient(
        baseUrl: 'http://localhost:3000',
        httpClient: fake,
      );

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
      final client = ApiClient(
        baseUrl: 'http://localhost:3000',
        httpClient: fake,
      );

      await expectLater(
        () => client.login('bad-token'),
        throwsA(isA<UnauthorizedError>()),
      );
      expect(client.isAuthenticated, isFalse);
    });

    test(
      'throws ApiException with the server message on other failures',
      () async {
        final fake = FakeHttpClient();
        fake.queueJson(400, {'error': 'malformed request'});
        final client = ApiClient(
          baseUrl: 'http://localhost:3000',
          httpClient: fake,
        );

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
      },
    );
  });

  group('ApiClient templates', () {
    test('lists templates and parses their summaries', () async {
      final fake = FakeHttpClient();
      final client = await _loggedInForTemplates(fake);
      fake.queueJson(200, [
        {
          'templateId': 'template-1',
          'version': 2,
          'name': 'Concierge',
          'digest': 'digest-1',
        },
      ]);

      final templates = await client.listTemplates();

      expect(templates, hasLength(1));
      expect(templates.single.name, 'Concierge');
      expect(templates.single.version, 2);
      final request = fake.requests.last;
      expect(request.method, 'GET');
      expect(request.url.path, '/templates');
    });

    test('exports a template and preserves credential-refusal diagnostics',
        () async {
      final fake = FakeHttpClient();
      final client = await _loggedInForTemplates(fake);
      fake.queueJson(201, {
        'templateId': 'template-1',
        'version': 1,
        'digest': 'digest-1',
      });

      final result = await client.exportRoleTemplate('role 1', 'Concierge');

      expect(result.templateId, 'template-1');
      final request = fake.requests.last as http.Request;
      expect(request.method, 'POST');
      expect(request.url.path, '/roles/role%201/templates');
      expect(jsonDecode(request.body), {'name': 'Concierge'});

      fake.queueJson(422, {
        'field_paths': ['/identity/instructions'],
        'classes': ['jwt'],
      });
      await expectLater(
        () => client.exportRoleTemplate('role-1', 'Unsafe'),
        throwsA(
          isA<TemplateExportRefusedException>().having(
              (error) => error.fieldPaths, 'field paths', [
            '/identity/instructions'
          ]).having((error) => error.classes, 'classes', ['jwt']),
        ),
      );
    });

    test('installs a template and parses its manual grant checklist', () async {
      final fake = FakeHttpClient();
      final client = await _loggedInForTemplates(fake);
      fake.queueJson(201, {
        'role': {'roleId': 'role-new'},
        'grant_checklist': [
          {
            'capability_id': 'mail.send',
            'requested_max_tier': 'T2_internal',
            'status': 'available',
          },
        ],
        'next': 'run one supervised turn before enabling routines',
      });

      final result = await client.installTemplate('template 1', 3);

      expect(result.roleId, 'role-new');
      expect(result.grantChecklist.single.capabilityId, 'mail.send');
      expect(result.grantChecklist.single.status, 'available');
      final request = fake.requests.last as http.Request;
      expect(request.method, 'POST');
      expect(request.url.path, '/templates/template%201/install');
      expect(jsonDecode(request.body), {'version': 3});
    });

    test('gets a role template status and parses changed sections', () async {
      final fake = FakeHttpClient();
      final client = await _loggedInForTemplates(fake);
      fake.queueJson(200, {
        'installed_from': {'templateId': 'template-1', 'version': 3},
        'drift': true,
        'changed': ['identity', 'skills'],
      });

      final status = await client.getRoleTemplateStatus('role 1');

      expect(status.installedFrom?.templateId, 'template-1');
      expect(status.installedFrom?.version, 3);
      expect(status.drift, isTrue);
      expect(status.changed, ['identity', 'skills']);
      final request = fake.requests.last;
      expect(request.method, 'GET');
      expect(request.url.path, '/roles/role%201/template-status');
    });
  });

  group('ApiClient.loginWithGoogle', () {
    test('posts idToken to /auth/google and captures the session cookie',
        () async {
      final fake = FakeHttpClient();
      fake.queueJson(
        200,
        {'authenticated': true},
        headers: {
          'set-cookie':
              'control_api_session=abc123; Path=/; HttpOnly; SameSite=Strict',
        },
      );
      final client = ApiClient(
        baseUrl: 'http://localhost:3000',
        httpClient: fake,
      );

      expect(client.isAuthenticated, isFalse);
      await client.loginWithGoogle('real-firebase-id-token');
      expect(client.isAuthenticated, isTrue);
      expect(client.cookieHeaders['cookie'], 'control_api_session=abc123');

      final request = fake.requests.single as http.Request;
      expect(request.url.path, '/auth/google');
      expect(request.method, 'POST');
      expect(jsonDecode(request.body), {'idToken': 'real-firebase-id-token'});
    });

    test(
      'throws UnauthorizedError on a rejected/expired Firebase ID token',
      () async {
        final fake = FakeHttpClient();
        fake.queueJson(401, {'error': 'invalid or expired Firebase ID token'});
        final client = ApiClient(
          baseUrl: 'http://localhost:3000',
          httpClient: fake,
        );

        await expectLater(
          () => client.loginWithGoogle('bad-or-expired-token'),
          throwsA(isA<UnauthorizedError>()),
        );
        expect(client.isAuthenticated, isFalse);
      },
    );
  });

  group('ApiClient.clearSession', () {
    test('drops the session cookie client-side', () async {
      final fake = FakeHttpClient();
      fake.queueJson(
        200,
        {'authenticated': true},
        headers: {'set-cookie': 'control_api_session=abc123; Path=/'},
      );
      final client = ApiClient(
        baseUrl: 'http://localhost:3000',
        httpClient: fake,
      );
      await client.loginWithGoogle('real-firebase-id-token');
      expect(client.isAuthenticated, isTrue);

      client.clearSession();

      expect(client.isAuthenticated, isFalse);
      expect(client.cookieHeaders, isEmpty);
    });
  });

  group('ApiClient authenticated calls', () {
    Future<ApiClient> loggedIn(FakeHttpClient fake) async {
      fake.queueJson(
        200,
        {'authenticated': true},
        headers: {'set-cookie': 'control_api_session=abc123; Path=/'},
      );
      final client = ApiClient(
        baseUrl: 'http://localhost:3000',
        httpClient: fake,
      );
      await client.login('shared-token');
      return client;
    }

    test(
      'registerDevice posts token/platform and replays the cookie',
      () async {
        final fake = FakeHttpClient();
        final client = await loggedIn(fake);
        fake.queueJson(201, {'registered': true});

        await client.registerDevice('fcm-token-abc', 'android');

        final request = fake.requests.last as http.Request;
        expect(request.method, 'POST');
        expect(request.url.path, '/devices');
        expect(request.headers['cookie'], 'control_api_session=abc123');
        expect(
          jsonDecode(request.body),
          {'token': 'fcm-token-abc', 'platform': 'android'},
        );
      },
    );

    test('registerDevice throws ApiException on a server rejection', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(
          400, {'error': 'platform must be one of: android, ios, web.'});

      await expectLater(
        () => client.registerDevice('fcm-token-abc', 'bogus'),
        throwsA(isA<ApiException>()),
      );
    });

    test('listRoles parses the role list and replays the cookie', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(200, [
        {
          'id': 'role-1',
          'name': 'Concierge',
          'description': 'Front desk',
          'avatarSeed': 'seed-1',
          'title': 'Front Desk Lead',
          'instructions': 'Be concise.',
        },
      ]);

      final roles = await client.listRoles();
      expect(roles, hasLength(1));
      expect(roles.single.name, 'Concierge');
      expect(roles.single.title, 'Front Desk Lead');
      expect(roles.single.instructions, 'Be concise.');

      final rolesRequest = fake.requests.last;
      expect(rolesRequest.headers['cookie'], 'control_api_session=abc123');
    });

    test('listRoles treats missing title and instructions as null', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(200, [
        {
          'id': 'role-1',
          'name': 'Concierge',
          'description': 'Front desk',
          'avatarSeed': 'seed-1',
          'title': null,
          'instructions': null,
        },
      ]);

      final roles = await client.listRoles();
      expect(roles.single.title, isNull);
      expect(roles.single.instructions, isNull);
    });

    test(
      'updateRoleInstructions PATCHes the required instructions field',
      () async {
        final fake = FakeHttpClient();
        final client = await loggedIn(fake);
        fake.queueJson(200, {
          'id': 'role-1',
          'name': 'Concierge',
          'description': 'Front desk',
          'avatarSeed': 'seed-1',
          'title': 'Front Desk Lead',
          'instructions': 'Answer as a calm research assistant.',
        });

        final role = await client.updateRoleInstructions(
          'role-1',
          'Answer as a calm research assistant.',
        );
        expect(role.instructions, 'Answer as a calm research assistant.');

        final request = fake.requests.last;
        expect(request.method, 'PATCH');
        expect(request.url.path, '/roles/role-1');
        expect(request, isA<http.Request>());
        expect(
          jsonDecode((request as http.Request).body),
          {'instructions': 'Answer as a calm research assistant.'},
        );
      },
    );

    test(
      'updateRoleInstructions sends an empty string to clear the persona',
      () async {
        final fake = FakeHttpClient();
        final client = await loggedIn(fake);
        fake.queueJson(200, {
          'id': 'role-1',
          'name': 'Concierge',
          'description': 'Front desk',
          'avatarSeed': 'seed-1',
          'title': 'Front Desk Lead',
          'instructions': '',
        });

        final role = await client.updateRoleInstructions('role 1', '');
        expect(role.instructions, '');

        final request = fake.requests.last as http.Request;
        expect(request.method, 'PATCH');
        expect(request.url.path, '/roles/role%201');
        expect(jsonDecode(request.body), {'instructions': ''});
      },
    );

    test(
      'updateRoleInstructions throws ApiException with the server message',
      () async {
        final fake = FakeHttpClient();
        final client = await loggedIn(fake);
        fake.queueJson(400, {'error': 'instructions is required'});

        await expectLater(
          () => client.updateRoleInstructions('role-1', 'persona'),
          throwsA(
            isA<ApiException>().having(
              (e) => e.message,
              'message',
              'instructions is required',
            ),
          ),
        );
      },
    );

    test(
      'createRole posts name/description and returns the created role',
      () async {
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
        final body =
            jsonDecode((request as http.Request).body) as Map<String, dynamic>;
        expect(body, {'name': 'Analyst', 'description': 'Numbers'});
      },
    );

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
      final body =
          jsonDecode((request as http.Request).body) as Map<String, dynamic>;
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

    test(
      'listThreadMessages passes the after cursor as a query param',
      () async {
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

        final messages = await client.listThreadMessages(
          'thread-1',
          after: 'msg-0',
        );
        expect(messages, hasLength(1));
        expect(messages.single.body, 'hello');

        final request = fake.requests.last;
        expect(request.url.path, '/threads/thread-1/messages');
        expect(request.url.queryParameters['after'], 'msg-0');
      },
    );

    test(
      'sendThreadMessage posts the body and returns the created message',
      () async {
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
      },
    );

    test(
        'uploadThreadAttachment posts base64 JSON and parses the structured ref',
        () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(201, {
        'id': 'att-1',
        'filename': 'notes.txt',
        'contentType': 'text/plain',
        'byteSize': 5,
        'sha256': 'aabbcc',
      });

      final attachment = await client.uploadThreadAttachment(
        'thread-1',
        filename: 'notes.txt',
        contentType: 'text/plain',
        bytes: utf8.encode('hello'),
      );
      expect(attachment.id, 'att-1');
      expect(attachment.filename, 'notes.txt');

      final request = fake.requests.last as http.Request;
      expect(request.method, 'POST');
      expect(request.url.path, '/threads/thread-1/attachments');
      expect(jsonDecode(request.body), {
        'filename': 'notes.txt',
        'contentType': 'text/plain',
        'contentBase64': base64Encode(utf8.encode('hello')),
      });
    });

    test('uploadThreadAttachment surfaces the server rejection message',
        () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(400, {
        'error': 'file exceeds the 10485760-byte limit.',
      });

      await expectLater(
        () => client.uploadThreadAttachment(
          'thread-1',
          filename: 'huge.txt',
          contentType: 'text/plain',
          bytes: utf8.encode('x'),
        ),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'file exceeds the 10485760-byte limit.',
          ),
        ),
      );
    });

    test('sendThreadMessage includes attachmentIds when provided', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(201, {
        'id': 'msg-3',
        'threadId': 'thread-1',
        'role': 'user',
        'body': 'see attached',
        'runId': null,
        'createdAt': '2026-09-05T00:00:00Z',
        'attachments': [
          {
            'id': 'att-1',
            'filename': 'notes.txt',
            'contentType': 'text/plain',
            'byteSize': 5,
            'sha256': 'aabbcc',
          },
        ],
      });

      final message = await client.sendThreadMessage(
        'thread-1',
        'see attached',
        attachmentIds: ['att-1'],
      );
      expect(message.attachments.single.filename, 'notes.txt');

      final request = fake.requests.last as http.Request;
      expect(jsonDecode(request.body), {
        'body': 'see attached',
        'attachmentIds': ['att-1'],
      });
    });

    test(
      'decideApproval uses the single-use decide endpoint and handles a no-op',
      () async {
        final fake = FakeHttpClient();
        final client = await loggedIn(fake);
        fake.queueJson(200, {'decided': true, 'approval': {}});
        fake.queueJson(409, {'decided': false});

        expect(
          await client.decideApproval('nonce / private', 'granted'),
          isTrue,
        );
        expect(
          await client.decideApproval('nonce / private', 'granted'),
          isFalse,
        );

        final first = fake.requests[1] as http.Request;
        expect(first.url.path, '/approvals/nonce%20%2F%20private/decide');
        expect(jsonDecode(first.body), {
          'decision': 'granted',
          'decidedBy': 'mobile:operator',
        });
      },
    );

    test('listRoutines parses read-only routine data', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(200, [
        {
          'routineId': 'routine-1',
          'name': 'Daily briefing',
          'schedule': '0 8 * * *',
          'lastFireAt': '2026-09-04T08:00:00Z',
          'nextFireAt': '2026-09-05T08:00:00Z',
        },
      ]);

      final routines = await client.listRoutines('role 1');
      expect(routines.single.name, 'Daily briefing');
      expect(fake.requests.last.url.path, '/roles/role%201/routines');
    });

    test(
        'reconstructs routine history through the real tasks and runs endpoints',
        () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(200, {
        'tasks': [
          {'taskId': 'task-1'},
        ],
        'nextCursor': null,
      });
      fake.queueJson(200, {
        'runs': [
          {
            'runId': 'run-1',
            'taskId': 'task-1',
            'status': 'failed',
            'startedAt': '2026-09-05T08:23:00Z',
          },
        ],
        'nextCursor': null,
      });

      final tasks = await client.listRoutineTasks('routine 1');
      final runs = await client.listRunsForTask(tasks.single.id);

      expect(fake.requests[1].url.path, '/tasks');
      expect(fake.requests[1].url.queryParameters, {'routineId': 'routine 1'});
      expect(fake.requests[2].url.path, '/runs');
      expect(fake.requests[2].url.queryParameters, {'taskId': 'task-1'});
      expect(runs.single.status, 'failed');
      expect(runs.single.startedAt, '2026-09-05T08:23:00Z');
    });

    test('createRoutine sends definition.goal only when a goal is given',
        () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(201, {
        'routineId': 'routine-2',
        'name': 'Daily briefing',
        'schedule': '0 8 * * *',
        'lastFireAt': null,
        'nextFireAt': '2026-09-06T08:00:00Z',
      });

      final routine = await client.createRoutine(
        'role 1',
        'Daily briefing',
        '0 8 * * *',
        goal: '  Summarize overnight alerts  ',
      );

      expect(routine.name, 'Daily briefing');
      final request = fake.requests.last as http.Request;
      expect(request.method, 'POST');
      expect(request.url.path, '/roles/role%201/routines');
      expect(jsonDecode(request.body), {
        'name': 'Daily briefing',
        'schedule': '0 8 * * *',
        'definition': {'goal': 'Summarize overnight alerts'},
      });
    });

    test('createRoutine omits definition entirely when no goal is given',
        () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(201, {
        'routineId': 'routine-3',
        'name': 'No-goal routine',
        'schedule': '0 9 * * *',
        'lastFireAt': null,
        'nextFireAt': null,
      });

      await client.createRoutine('role 1', 'No-goal routine', '0 9 * * *');

      final request = fake.requests.last as http.Request;
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      expect(body.containsKey('definition'), isFalse);
      expect(body, {'name': 'No-goal routine', 'schedule': '0 9 * * *'});
    });

    test('createRoutine surfaces a server validation error', () async {
      final fake = FakeHttpClient();
      final client = await loggedIn(fake);
      fake.queueJson(
          400, {'error': 'schedule must be a valid 5-field cron expression.'});

      await expectLater(
        () => client.createRoutine('role 1', 'Bad cron', 'not-a-cron'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'schedule must be a valid 5-field cron expression.',
          ),
        ),
      );
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

    test(
      'getTakeoverStatus parses a real pending status',
      () async {
        final fake = FakeHttpClient();
        final client = await loggedIn(fake);
        fake.queueJson(200, {
          'pending': true,
          'kind': 'captcha',
          'detail': 'detected captcha page',
        });

        final status = await client.getTakeoverStatus('run-1');
        expect(status.pending, isTrue);
        expect(status.kind, 'captcha');
        expect(status.detail, 'detected captcha page');
        expect(fake.requests.last.url.path, '/runs/run-1/takeover');
      },
    );

    test(
      'getTakeoverStatus treats a 501 (no TakeoverPort configured) as nothing pending, not an error',
      () async {
        final fake = FakeHttpClient();
        final client = await loggedIn(fake);
        fake.queueJson(501, {'error': 'take-over is not configured'});

        final status = await client.getTakeoverStatus('run-1');
        expect(status.pending, isFalse);
      },
    );

    test(
      'getTakeoverStatus treats a 404 (run not found/not owned) as nothing pending, not an error',
      () async {
        final fake = FakeHttpClient();
        final client = await loggedIn(fake);
        fake.queueJson(404, {'error': 'run not found'});

        final status = await client.getTakeoverStatus('run-1');
        expect(status.pending, isFalse);
      },
    );

    test(
      'completeTakeover posts to the complete endpoint and handles the 409 no-op',
      () async {
        final fake = FakeHttpClient();
        final client = await loggedIn(fake);
        fake.queueJson(200, {'completed': true});
        fake.queueJson(409, {'completed': false, 'reason': 'not_pending'});

        expect(await client.completeTakeover('run-1'), isTrue);
        expect(await client.completeTakeover('run-1'), isFalse);

        final first = fake.requests[1] as http.Request;
        expect(first.url.path, '/runs/run-1/takeover/complete');
        expect(first.method, 'POST');
      },
    );
  });

  group('project routes (TASK-307)', () {
    const proj = {
      'projectId': 'p1',
      'threadId': 't1',
      'name': 'Launch',
      'goal': 'g',
      'doneCriterion': 'd',
      'status': 'active',
      'budgetUsd': null,
      'createdBy': 'human:x',
      'createdAt': '2026-09-20T00:00:00.000Z',
      'updatedAt': '2026-09-20T00:00:00.000Z',
    };
    const task = {
      'taskId': 'k1',
      'projectId': 'p1',
      'title': 'T',
      'description': '',
      'ownerRoleId': null,
      'state': 'todo',
      'blockedReason': null,
      'doneCriterion': null,
      'createdBy': 'human:x',
      'createdAt': '',
      'updatedAt': '',
    };
    const artifact = {
      'artifactId': 'a1',
      'projectId': 'p1',
      'taskId': null,
      'kind': 'attachment',
      'ref': 'r',
      'sha256': null,
      'byteSize': null,
      'producedByRoleId': null,
      'producedByRunId': null,
      'label': 'STATUS.md',
      'createdAt': '2026-09-20T00:00:00.000Z',
    };

    Future<(ApiClient, FakeHttpClient)> setup() async {
      final fake = FakeHttpClient();
      final client = await _loggedInForTemplates(fake);
      return (client, fake);
    }

    http.Request last(FakeHttpClient f) => f.requests.last as http.Request;
    Map<String, dynamic> lastBody(FakeHttpClient f) =>
        jsonDecode(last(f).body) as Map<String, dynamic>;

    test('createProject sends charter fields and roster', () async {
      final (client, fake) = await setup();
      fake.queueJson(201, {
        'project': proj,
        'roster': [
          {'roleId': 'r1', 'isManager': true, 'responsibility': ''},
        ],
      });
      final out = await client.createProject(
        name: 'Launch',
        goal: 'g',
        doneCriterion: 'd',
        boundaries: 'b',
        checkWithMeBefore: 'c',
        roster: [
          {'roleId': 'r1', 'isManager': true},
          {'roleId': 'r2'},
        ],
      );
      expect(out.project.name, 'Launch');
      expect(out.roster.single.isManager, isTrue);
      expect(last(fake).method, 'POST');
      expect(last(fake).url.path, '/projects');
      final body = lastBody(fake);
      expect(body['boundaries'], 'b');
      expect(body['checkWithMeBefore'], 'c');
      expect((body['roster'] as List).length, 2);
    });

    test('createProject surfaces the server rejection', () async {
      final (client, fake) = await setup();
      fake.queueJson(400, {'error': 'a project has at most one manager.'});
      expect(
        () => client.createProject(
          name: 'n',
          goal: 'g',
          doneCriterion: 'd',
          roster: [],
        ),
        throwsA(isA<ApiException>().having(
            (e) => e.message, 'message', 'a project has at most one manager.')),
      );
    });

    test('listProjects / getProject', () async {
      final (client, fake) = await setup();
      fake.queueJson(200, [proj]);
      expect((await client.listProjects(status: 'active')).single.projectId,
          'p1');
      expect(last(fake).url.toString(), endsWith('/projects?status=active'));

      fake.queueJson(200, {
        ...proj,
        'charter': {'goal': 'g'},
        'roster': [],
        'board': {'todo': 2},
        'latestStatusArtifact': artifact,
        'spend': {'usd': 1.5, 'budgetUsd': null},
      });
      final detail = await client.getProject('p1');
      expect(detail.board['todo'], 2);
      expect(detail.charter['goal'], 'g');
      expect(detail.latestStatusArtifact?.label, 'STATUS.md');
      expect(detail.spendUsd, 1.5);
      expect(last(fake).url.path, '/projects/p1');
    });

    test('updateProject PATCHes and can clear the manager', () async {
      final (client, fake) = await setup();
      fake.queueJson(200, {'project': proj, 'roster': []});
      await client.updateProject('p1', status: 'paused', clearManager: true);
      expect(last(fake).method, 'PATCH');
      expect(last(fake).url.path, '/projects/p1');
      final body = lastBody(fake);
      expect(body['status'], 'paused');
      expect(body.containsKey('managerRoleId'), isTrue);
      expect(body['managerRoleId'], isNull);
    });

    test('task routes', () async {
      final (client, fake) = await setup();
      fake.queueJson(200, [task]);
      expect((await client.listProjectTasks('p1', state: 'todo')).single.title,
          'T');
      expect(last(fake).url.toString(),
          endsWith('/projects/p1/tasks?state=todo'));

      fake.queueJson(201, task);
      await client.createProjectTask('p1', title: 'T', ownerRoleId: 'r1');
      expect(last(fake).method, 'POST');
      expect(lastBody(fake)['ownerRoleId'], 'r1');

      fake.queueJson(
          200, {...task, 'state': 'blocked', 'blockedReason': 'why'});
      final t = await client.updateProjectTask('p1', 'k1',
          state: 'blocked', blockedReason: 'why');
      expect(t.blockedReason, 'why');
      expect(last(fake).method, 'PATCH');
      expect(last(fake).url.path, '/projects/p1/tasks/k1');
    });

    test('artifact and decision routes', () async {
      final (client, fake) = await setup();
      fake.queueJson(200, [artifact]);
      expect(
          (await client.listProjectArtifacts('p1')).single.label, 'STATUS.md');
      expect(last(fake).url.path, '/projects/p1/artifacts');

      fake.queueJson(201, artifact);
      await client.createProjectArtifact('p1',
          kind: 'attachment', ref: 'r', label: 'STATUS.md');
      expect(last(fake).method, 'POST');
      expect(lastBody(fake)['kind'], 'attachment');

      fake.queueJson(200, [
        {
          'decisionId': 'd1',
          'projectId': 'p1',
          'taskId': null,
          'kind': 'human_decision',
          'approvalId': null,
          'summary': 'go',
          'actor': 'human:x',
          'createdAt': '',
        },
      ]);
      expect((await client.listProjectDecisions('p1')).single.summary, 'go');
      expect(last(fake).url.path, '/projects/p1/decisions');
    });
  });
}
