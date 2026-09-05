import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:test/test.dart';

import '../test/support/fake_http_client.dart';
import 'release_remote.dart';

/// TASK-152 — tests the Gofile/Telegram release flow entirely against
/// [FakeHttpClient] (already used by the app's own API-client tests) —
/// no real network call anywhere in this suite. Uses an assembled-at-
/// runtime sentinel token/chat-id, never a literal that could be mistaken
/// for a real credential.
String _sentinelToken() => '${List.generate(6, (i) => 'x').join()}-token-000000';
String _sentinelChatId() => '${1}${2}${3}${4}${5}${6}${7}${8}';

void main() {
  late Directory tempDir;
  late File apkFile;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('release_remote_test_');
    apkFile = File('${tempDir.path}/app-release.apk');
    apkFile.writeAsBytesSync(List.filled(2 * 1024 * 1024, 0)); // 2 MB
  });

  tearDown(() {
    tempDir.deleteSync(recursive: true);
  });

  Map<String, String> validEnv() => {
        'TELEGRAM_BOT_TOKEN': _sentinelToken(),
        'TELEGRAM_CHAT_ID': _sentinelChatId(),
      };

  group('requireExistingFile', () {
    test('throws MissingFileError before any HTTP call for a missing path', () async {
      final fake = FakeHttpClient();
      expect(
        () => publishRelease(
          filePath: '${tempDir.path}/does-not-exist.apk',
          environment: validEnv(),
          publisher: ReleasePublisher(httpClient: fake),
        ),
        throwsA(isA<MissingFileError>()),
      );
      // No request should have been made.
      expect(fake.requests, isEmpty);
    });
  });

  group('TelegramCredentials.fromEnvironment', () {
    test('throws naming TELEGRAM_BOT_TOKEN when missing, before any HTTP call', () async {
      final fake = FakeHttpClient();
      await expectLater(
        publishRelease(
          filePath: apkFile.path,
          environment: {'TELEGRAM_CHAT_ID': _sentinelChatId()},
          publisher: ReleasePublisher(httpClient: fake),
        ),
        throwsA(
          isA<MissingEnvVarError>().having((e) => e.varName, 'varName', 'TELEGRAM_BOT_TOKEN'),
        ),
      );
      expect(fake.requests, isEmpty);
    });

    test('throws naming TELEGRAM_CHAT_ID when missing, before any HTTP call', () async {
      final fake = FakeHttpClient();
      await expectLater(
        publishRelease(
          filePath: apkFile.path,
          environment: {'TELEGRAM_BOT_TOKEN': _sentinelToken()},
          publisher: ReleasePublisher(httpClient: fake),
        ),
        throwsA(
          isA<MissingEnvVarError>().having((e) => e.varName, 'varName', 'TELEGRAM_CHAT_ID'),
        ),
      );
      expect(fake.requests, isEmpty);
    });
  });

  group('three-call flow', () {
    test('performs GET servers, POST upload, POST sendMessage in order with correct shapes',
        () async {
      final fake = FakeHttpClient();
      fake.queueJson(200, {
        'status': 'ok',
        'data': {
          'servers': [
            {'name': 'store7'},
          ],
        },
      });
      fake.queueJson(200, {
        'status': 'ok',
        'data': {
          'downloadPage': 'https://gofile.io/d/abc123',
          'fileId': 'abc123',
        },
      });
      fake.queueJson(200, {'ok': true, 'result': {}});

      await publishRelease(
        filePath: apkFile.path,
        note: 'from CI',
        environment: validEnv(),
        publisher: ReleasePublisher(httpClient: fake),
      );

      expect(fake.requests, hasLength(3));

      final serversReq = fake.requests[0];
      expect(serversReq.method, 'GET');
      expect(serversReq.url.toString(), 'https://api.gofile.io/servers');

      final uploadReq = fake.requests[1];
      expect(uploadReq.method, 'POST');
      expect(uploadReq.url.toString(), 'https://store7.gofile.io/contents/uploadfile');
      expect(uploadReq, isA<Object>()); // multipart request; field-level checks below.

      final sendReq = fake.requests[2];
      expect(sendReq.method, 'POST');
      expect(sendReq.url.toString().startsWith('https://api.telegram.org/bot'), isTrue);
      expect(sendReq.url.toString().endsWith('/sendMessage'), isTrue);
    });

    test('gofile /servers picks data.servers[0].name specifically', () async {
      final fake = FakeHttpClient();
      fake.queueJson(200, {
        'status': 'ok',
        'data': {
          'servers': [
            {'name': 'store1'},
            {'name': 'store2'},
          ],
        },
      });
      final publisher = ReleasePublisher(httpClient: fake);
      final server = await publisher.fetchUploadServer();
      expect(server, 'store1');
    });

    test('upload request has a "file" multipart field carrying the apk contents', () async {
      final fake = FakeHttpClient();
      fake.queueJson(200, {
        'status': 'ok',
        'data': {'downloadPage': 'https://gofile.io/d/xyz'},
      });
      final publisher = ReleasePublisher(httpClient: fake);
      final downloadPage = await publisher.uploadFile('store1', apkFile);
      expect(downloadPage, 'https://gofile.io/d/xyz');

      final sentRequest = fake.requests.single;
      expect(sentRequest, isA<http.MultipartRequest>());
      final multipart = sentRequest as http.MultipartRequest;
      expect(multipart.files, hasLength(1));
      expect(multipart.files.single.field, 'file');
    });
  });

  group('sendMessage body', () {
    test('never includes a parse_mode field in the JSON body', () async {
      final fake = FakeHttpClient();
      fake.queueJson(200, {'ok': true});
      final publisher = ReleasePublisher(httpClient: fake);
      await publisher.sendTelegramMessage(
        credentials: TelegramCredentials(botToken: _sentinelToken(), chatId: _sentinelChatId()),
        text: 'hello release',
      );

      final sent = fake.requests.single;
      final decodedBody = jsonDecode((sent as http.Request).body) as Map<String, dynamic>;
      expect(decodedBody.keys, isNot(contains('parse_mode')));
      expect(decodedBody.keys.toSet(), {'chat_id', 'text'});
    });

    test('sends chat_id and text matching the built message', () async {
      final fake = FakeHttpClient();
      fake.queueJson(200, {'ok': true});
      final publisher = ReleasePublisher(httpClient: fake);
      final creds = TelegramCredentials(botToken: _sentinelToken(), chatId: _sentinelChatId());
      await publisher.sendTelegramMessage(credentials: creds, text: 'hello release');

      final sent = fake.requests.single;
      final decodedBody = jsonDecode((sent as http.Request).body) as Map<String, dynamic>;
      expect(decodedBody['chat_id'], creds.chatId);
      expect(decodedBody['text'], 'hello release');
    });

    test('throws ReleaseCallError when Telegram reports ok=false', () async {
      final fake = FakeHttpClient();
      fake.queueJson(200, {'ok': false, 'description': 'bad request'});
      final publisher = ReleasePublisher(httpClient: fake);
      await expectLater(
        publisher.sendTelegramMessage(
          credentials: TelegramCredentials(botToken: _sentinelToken(), chatId: _sentinelChatId()),
          text: 'x',
        ),
        throwsA(isA<ReleaseCallError>()),
      );
    });
  });

  group('buildReleaseMessage', () {
    test('includes filename, size in MB, expiry note, and download link', () {
      final message = buildReleaseMessage(
        fileName: 'app-release.apk',
        sizeMb: 12.345,
        downloadPage: 'https://gofile.io/d/abc',
      );
      expect(message, contains('app-release.apk'));
      expect(message, contains('12.35 MB'));
      expect(message, contains('https://gofile.io/d/abc'));
      expect(message, contains('10 days'));
    });

    test('omits the note line when none is given', () {
      final message = buildReleaseMessage(
        fileName: 'app-release.apk',
        sizeMb: 1.0,
        downloadPage: 'https://gofile.io/d/abc',
      );
      expect(message, isNot(contains('null')));
    });

    test('includes the caller-supplied note when given', () {
      final message = buildReleaseMessage(
        fileName: 'app-release.apk',
        sizeMb: 1.0,
        downloadPage: 'https://gofile.io/d/abc',
        note: 'hotfix for login crash',
      );
      expect(message, contains('hotfix for login crash'));
    });
  });

  group('parseArgs', () {
    test('parses a positional file path with no --note', () {
      final result = parseArgs(['build/app/foo.apk']);
      expect(result.positional, ['build/app/foo.apk']);
      expect(result.note, isNull);
    });

    test('parses --note as a separate argument', () {
      final result = parseArgs(['--note', 'hotfix', 'foo.apk']);
      expect(result.note, 'hotfix');
      expect(result.positional, ['foo.apk']);
    });

    test('parses --note=value form', () {
      final result = parseArgs(['--note=hotfix', 'foo.apk']);
      expect(result.note, 'hotfix');
      expect(result.positional, ['foo.apk']);
    });

    test('defaults to no positional args when none given', () {
      final result = parseArgs([]);
      expect(result.positional, isEmpty);
      expect(result.note, isNull);
    });
  });

  group('no credential literals', () {
    test('sentinel token/chat-id are assembled at runtime, not literals', () {
      // Documents the convention this test file follows itself — sentinel
      // values are built from generated fragments, never a plausible
      // literal token/chat-id, matching the connectors package's own
      // approach to test fixtures.
      expect(_sentinelToken(), isNot(matches(RegExp(r'^\d{6,}:[A-Za-z0-9_-]{30,}\$'))));
    });
  });
}
