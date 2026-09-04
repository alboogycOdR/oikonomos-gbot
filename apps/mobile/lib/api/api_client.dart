import 'dart:convert';

import 'package:http/http.dart' as http;

import 'exceptions.dart';
import 'models.dart';

/// TASK-144 (Mobile Wave 1a) — typed Dart client for control-api, mirroring
/// `apps/dashboard/src/lib/api.ts`'s request/error semantics for the
/// endpoints this task covers.
///
/// Unlike the dashboard (a browser client that never touches the session
/// cookie directly — `credentials: "same-origin"` lets the browser manage
/// it), a native client has no browser cookie jar: this class captures the
/// `set-cookie` header itself on a successful [login] and replays it as a
/// `Cookie` header on every subsequent request, kept only in memory for the
/// lifetime of this object. The raw access token is never stored beyond
/// the single [login] call that submits it — only the opaque session
/// cookie value is retained, matching non-negotiable 4 (no credentials
/// persisted/logged) applied to the shared token exactly as to any other
/// secret.
class ApiClient {
  ApiClient({required String baseUrl, http.Client? httpClient})
    : baseUrl = _stripTrailingSlash(baseUrl),
      _client = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  String? _sessionCookie;

  /// True once a session cookie has been captured by a successful [login].
  /// Exposed for UI/tests; never exposes the cookie's value itself.
  bool get isAuthenticated => _sessionCookie != null;

  /// Header(s) needed to authenticate an out-of-band request (the SSE
  /// stream connection, opened by [SseThreadSubscription] rather than this
  /// class) with the same session credential every other call uses. Never
  /// exposes the raw access token — only the already-issued session
  /// cookie, which is itself the intended replay credential per
  /// `services/control-api/src/auth.ts`.
  Map<String, String> get cookieHeaders =>
      _sessionCookie == null ? const {} : {'cookie': _sessionCookie!};

  static String _stripTrailingSlash(String url) =>
      url.endsWith('/') ? url.substring(0, url.length - 1) : url;

  Map<String, String> _headers({bool json = true}) {
    final headers = <String, String>{};
    if (json) {
      headers['content-type'] = 'application/json';
    }
    if (_sessionCookie != null) {
      headers['cookie'] = _sessionCookie!;
    }
    return headers;
  }

  /// Captures the session cookie from a `set-cookie` response header.
  /// Only the `name=value` pair is retained — cookie attributes
  /// (`Path`, `HttpOnly`, `SameSite`, `Expires`, ...) are the server's
  /// concern for the browser case and are meaningless to replay manually
  /// as a request header here.
  void _captureCookie(http.BaseResponse response) {
    final setCookie = response.headers['set-cookie'];
    if (setCookie == null) return;
    final firstPair = setCookie.split(';').first.trim();
    if (firstPair.isNotEmpty) {
      _sessionCookie = firstPair;
    }
  }

  Never _throwForError(http.BaseResponse response, String body) {
    if (response.statusCode == 401) {
      throw const UnauthorizedError();
    }
    var message = 'request failed with ${response.statusCode}';
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic> && decoded['error'] is String) {
        message = decoded['error'] as String;
      }
    } catch (_) {
      // Response body wasn't JSON — keep the generic message.
    }
    throw ApiException(message);
  }

  Future<dynamic> _request(
    String method,
    String path, {
    Object? body,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    late final http.Response response;
    switch (method) {
      case 'GET':
        response = await _client.get(uri, headers: _headers(json: false));
        break;
      case 'POST':
        response = await _client.post(
          uri,
          headers: _headers(),
          body: body == null ? null : jsonEncode(body),
        );
        break;
      default:
        throw ArgumentError('unsupported method $method');
    }
    _captureCookie(response);
    if (response.statusCode == 401) {
      throw const UnauthorizedError();
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      _throwForError(response, response.body);
    }
    if (response.statusCode == 204 || response.body.isEmpty) {
      return null;
    }
    return jsonDecode(response.body);
  }

  /// `POST /auth/login` — exchanges the shared access token for a session
  /// cookie, captured internally. Throws [UnauthorizedError] on an
  /// invalid token (server's 401), [ApiException] on any other failure.
  Future<void> login(String token) async {
    await _request('POST', '/auth/login', body: {'token': token});
  }

  Future<List<Role>> listRoles() async {
    final json = await _request('GET', '/roles') as List<dynamic>;
    return json
        .map((entry) => Role.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  Future<Role> createRole(String name, String description) async {
    final json = await _request(
      'POST',
      '/roles',
      body: {'name': name, 'description': description},
    );
    return Role.fromJson(json as Map<String, dynamic>);
  }

  Future<List<ThreadSummary>> listThreads() async {
    final json = await _request('GET', '/threads') as List<dynamic>;
    return json
        .map(
          (entry) => ThreadSummary.fromJson(entry as Map<String, dynamic>),
        )
        .toList();
  }

  Future<List<ThreadMessage>> listThreadMessages(
    String threadId, {
    String? after,
  }) async {
    final query = after == null ? '' : '?after=${Uri.encodeComponent(after)}';
    final json =
        await _request(
              'GET',
              '/threads/${Uri.encodeComponent(threadId)}/messages$query',
            )
            as List<dynamic>;
    return json
        .map((entry) => ThreadMessage.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  Future<ThreadMessage> sendThreadMessage(String threadId, String body) async {
    final json = await _request(
      'POST',
      '/threads/${Uri.encodeComponent(threadId)}/messages',
      body: {'body': body},
    );
    return ThreadMessage.fromJson(json as Map<String, dynamic>);
  }

  void close() {
    _client.close();
  }
}
