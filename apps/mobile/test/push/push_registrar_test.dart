import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/api/api_client.dart';
import 'package:oikonomos_mobile/push/push_message.dart';
import 'package:oikonomos_mobile/push/push_registrar.dart';

import '../support/fake_http_client.dart';
import '../support/fake_push_port.dart';

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

void main() {
  group('PushRegistrar', () {
    test(
      'a dormant (Noop-equivalent) port with no token registers nothing',
      () async {
        final fake = FakeHttpClient();
        final client = await _loggedIn(fake);
        final port = FakePushPort(initialToken: null);
        final registrar = PushRegistrar(
          apiClient: client,
          port: port,
          devicePlatform: () => 'android',
        );

        await registrar.initialize();

        expect(port.getTokenCallCount, 1);
        expect(registrar.hasRegistered, isFalse);
        // Only the login request was ever made — no /devices call.
        expect(fake.requests, hasLength(1));
      },
    );

    test(
      'an initial token registers via POST /devices with the platform',
      () async {
        final fake = FakeHttpClient();
        final client = await _loggedIn(fake);
        fake.queueJson(201, {'registered': true});
        final port = FakePushPort(initialToken: 'token-1');
        final registrar = PushRegistrar(
          apiClient: client,
          port: port,
          devicePlatform: () => 'ios',
        );

        await registrar.initialize();

        expect(registrar.hasRegistered, isTrue);
        final request = fake.requests.last;
        expect(request.url.path, '/devices');
        expect(
          jsonDecode((request as dynamic).body as String),
          {'token': 'token-1', 'platform': 'ios'},
        );
      },
    );

    test('a token rotation re-registers with the new token', () async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      fake.queueJson(201, {'registered': true}); // initial token
      final port = FakePushPort(initialToken: 'token-1');
      final registrar = PushRegistrar(
        apiClient: client,
        port: port,
        devicePlatform: () => 'android',
      );
      await registrar.initialize();

      fake.queueJson(201, {'registered': true}); // rotated token
      port.emitTokenRefresh('token-2');
      await pumpEventQueue();

      final request = fake.requests.last;
      expect(
        jsonDecode((request as dynamic).body as String),
        {'token': 'token-2', 'platform': 'android'},
      );
    });

    test(
      'a registration failure is reported but never thrown',
      () async {
        final fake = FakeHttpClient();
        final client = await _loggedIn(fake);
        fake.queueJson(400, {'error': 'platform must be one of: android, ios, web.'});
        final port = FakePushPort(initialToken: 'token-1');
        Object? reported;
        final registrar = PushRegistrar(
          apiClient: client,
          port: port,
          devicePlatform: () => 'android',
          onRegistrationError: (error) => reported = error,
        );

        await registrar.initialize();

        expect(registrar.hasRegistered, isFalse);
        expect(reported, isNotNull);
      },
    );

    test('a foreground message is forwarded decoded to the caller', () async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      final port = FakePushPort(initialToken: null);
      PushMessage? received;
      final registrar = PushRegistrar(
        apiClient: client,
        port: port,
        devicePlatform: () => 'android',
        onMessage: (message) => received = message,
      );
      await registrar.initialize();

      port.emitMessage(
        const PushMessage(
          type: PushMessageType.approvalPending,
          runId: 'run-1',
        ),
      );
      await pumpEventQueue();

      expect(received, isNotNull);
      expect(received!.type, PushMessageType.approvalPending);
      expect(received!.runId, 'run-1');
    });

    test('dispose cancels subscriptions and disposes the port', () async {
      final fake = FakeHttpClient();
      final client = await _loggedIn(fake);
      final port = FakePushPort(initialToken: null);
      final registrar = PushRegistrar(
        apiClient: client,
        port: port,
        devicePlatform: () => 'android',
      );
      await registrar.initialize();

      registrar.dispose();

      expect(port.disposed, isTrue);
    });
  });

  group('PushMessage.fromData', () {
    test('decodes a recognized approval-pending payload', () {
      final message = PushMessage.fromData({
        'type': 'approval-pending',
        'runId': 'run-1',
      });
      expect(message, isNotNull);
      expect(message!.type, PushMessageType.approvalPending);
    });

    test('decodes a recognized run-completed payload', () {
      final message = PushMessage.fromData({
        'type': 'run-completed',
        'runId': 'run-2',
      });
      expect(message, isNotNull);
      expect(message!.type, PushMessageType.runCompleted);
    });

    test('returns null for an unrecognized type', () {
      expect(
        PushMessage.fromData({'type': 'something-else', 'runId': 'run-3'}),
        isNull,
      );
    });

    test('returns null for a missing runId', () {
      expect(
        PushMessage.fromData({'type': 'run-completed'}),
        isNull,
      );
    });
  });
}
