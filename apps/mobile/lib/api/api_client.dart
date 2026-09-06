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

  /// TASK-147 (Mobile Wave 1b) — exposes the same [http.Client] instance
  /// this class was constructed with, so a single request client (real
  /// or, in widget tests, a [FakeHttpClient]) is shared between plain
  /// REST calls here and the held-open SSE subscription
  /// (`subscribeToThreadMessages`), rather than the SSE layer silently
  /// opening a second, un-injectable `http.Client()` of its own.
  http.Client get httpClient => _client;

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

  Future<dynamic> _request(String method, String path, {Object? body}) async {
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
      case 'PATCH':
        response = await _client.patch(
          uri,
          headers: _headers(),
          body: body == null ? null : jsonEncode(body),
        );
        break;
      case 'PUT':
        response = await _client.put(
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

  /// TASK-173 — `POST /auth/google` (`services/control-api/src/app.ts`):
  /// exchanges a real, already-verified-client-side Firebase ID token for a
  /// UID-scoped session cookie, captured internally exactly like [login].
  /// The request/response shape (`{idToken}` in, a `set-cookie` header plus
  /// `{authenticated: true}` on 200) is the real route's, not a guess — read
  /// from `services/control-api/src/app.ts` and its `GoogleLoginRequest`
  /// OpenAPI schema before writing this method. Throws [UnauthorizedError]
  /// on a rejected/expired token (server's 401, e.g. JWKS verification
  /// failure), [ApiException] on any other failure.
  Future<void> loginWithGoogle(String idToken) async {
    await _request('POST', '/auth/google', body: {'idToken': idToken});
  }

  /// TASK-173 — clears the client-side session cookie captured by [login]
  /// or [loginWithGoogle]. Sessions are stateless signed tokens
  /// (`services/control-api/src/auth.ts`'s `createSessionToken`), not rows
  /// in a server-side store, so there is nothing to revoke server-side:
  /// dropping the cookie here is the real, complete client-side sign-out.
  /// Callers pairing this with a Google sign-out (see
  /// `screens/login_screen.dart`'s `GoogleAuthPort.signOut`) should call
  /// both so neither the app session nor the cached Google account survive.
  void clearSession() {
    _sessionCookie = null;
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

  /// `PATCH /roles/:roleId` — `{instructions: string}` is required. Send
  /// an empty string to clear a previously set persona (TASK-156 contract).
  Future<Role> updateRoleInstructions(
    String roleId,
    String instructions,
  ) async {
    final json = await _request(
      'PATCH',
      '/roles/${Uri.encodeComponent(roleId)}',
      body: {'instructions': instructions},
    );
    return Role.fromJson(json as Map<String, dynamic>);
  }

  Future<List<Skill>> listSkills() async {
    final json = await _request('GET', '/skills') as List<dynamic>;
    return json
        .map((entry) => Skill.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  Future<Skill> createSkill({
    required String name,
    required String description,
    required String body,
    String? whenToUse,
    List<String> approvals = const [],
  }) async {
    final json = await _request('POST', '/skills', body: {
      'name': name,
      'description': description,
      'body': body,
      if (whenToUse != null && whenToUse.trim().isNotEmpty)
        'whenToUse': whenToUse.trim(),
      if (approvals.isNotEmpty) 'approvals': approvals,
    });
    return Skill.fromJson(json as Map<String, dynamic>);
  }

  Future<Skill> updateSkill(
    String skillId, {
    required String name,
    required String description,
    required String body,
    String? whenToUse,
    List<String> approvals = const [],
  }) async {
    final json = await _request(
      'PATCH',
      '/skills/${Uri.encodeComponent(skillId)}',
      body: {
        'name': name,
        'description': description,
        'body': body,
        'whenToUse':
            whenToUse?.trim().isEmpty ?? true ? null : whenToUse?.trim(),
        'approvals': approvals,
      },
    );
    return Skill.fromJson(json as Map<String, dynamic>);
  }

  Future<List<Skill>> listRoleSkills(String roleId) async {
    final json = await _request(
      'GET',
      '/roles/${Uri.encodeComponent(roleId)}/skills',
    ) as List<dynamic>;
    return json
        .map((entry) => Skill.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  /// Returns the server-confirmed state. Callers must not treat a tap as
  /// authoritative: server-side enablement remains the enforcement point.
  Future<bool> setRoleSkillEnabled(
    String roleId,
    String skillId,
    bool enabled,
  ) async {
    final json = await _request(
      'PUT',
      '/roles/${Uri.encodeComponent(roleId)}/skills/${Uri.encodeComponent(skillId)}',
      body: {'enabled': enabled},
    ) as Map<String, dynamic>;
    return json['enabled'] as bool;
  }

  Future<List<ThreadSummary>> listThreads() async {
    final json = await _request('GET', '/threads') as List<dynamic>;
    return json
        .map((entry) => ThreadSummary.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  Future<List<ThreadMessage>> listThreadMessages(
    String threadId, {
    String? after,
  }) async {
    final query = after == null ? '' : '?after=${Uri.encodeComponent(after)}';
    final json = await _request(
      'GET',
      '/threads/${Uri.encodeComponent(threadId)}/messages$query',
    ) as List<dynamic>;
    return json
        .map((entry) => ThreadMessage.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  Future<List<RoleHandoff>> listRoleHandoffs(String roleId) async {
    final json = await _request(
      'GET',
      '/roles/${Uri.encodeComponent(roleId)}/messages',
    ) as List<dynamic>;
    return json
        .map((entry) => RoleHandoff.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  Future<ThreadMessage> sendThreadMessage(
    String threadId,
    String body, {
    List<String>? attachmentIds,
  }) async {
    final json = await _request(
      'POST',
      '/threads/${Uri.encodeComponent(threadId)}/messages',
      body: {
        'body': body,
        if (attachmentIds != null && attachmentIds.isNotEmpty)
          'attachmentIds': attachmentIds,
      },
    );
    return ThreadMessage.fromJson(json as Map<String, dynamic>);
  }

  /// TASK-166 — `POST /threads/:id/attachments`. Bytes are sent as
  /// base64 JSON (control-api has no multipart plugin in-territory).
  Future<MessageAttachment> uploadThreadAttachment(
    String threadId, {
    required String filename,
    required String contentType,
    required List<int> bytes,
  }) async {
    final json = await _request(
      'POST',
      '/threads/${Uri.encodeComponent(threadId)}/attachments',
      body: {
        'filename': filename,
        'contentType': contentType,
        'contentBase64': base64Encode(bytes),
      },
    );
    return MessageAttachment.fromJson(json as Map<String, dynamic>);
  }

  /// TASK-147 (Mobile Wave 1b) — `POST /threads`, the second call of the
  /// create-bot sequence (mirrors
  /// `apps/dashboard/src/components/chat/CreateBotDialog.tsx`'s
  /// `postJson<CreatedThread>("/threads", { roleId })`). The server
  /// (`services/control-api/src/app.ts`) returns the raw db `Thread` row
  /// here, not the shaped `GET /threads` entry (no `botName`/
  /// `avatarSeed`/`lastMessagePreview`) — only the new thread's `id` is
  /// needed by callers, who reload the roster via [listThreads] for the
  /// fully shaped entry, same as the web dialog's full-page reload.
  Future<String> createThread(String roleId) async {
    final json = await _request('POST', '/threads', body: {'roleId': roleId});
    return (json as Map<String, dynamic>)['id'] as String;
  }

  /// Decides an approval using the same body and single-use semantics as
  /// the dashboard. A 409 is an expected result: another client may already
  /// have consumed this nonce, so callers can disable the card gracefully.
  Future<bool> decideApproval(String nonce, String decision) async {
    final uri = Uri.parse(
      '$baseUrl/approvals/${Uri.encodeComponent(nonce)}/decide',
    );
    final response = await _client.post(
      uri,
      headers: _headers(),
      body: jsonEncode({'decision': decision, 'decidedBy': 'mobile:operator'}),
    );
    _captureCookie(response);
    if (response.statusCode == 409) return false;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      _throwForError(response, response.body);
    }
    return true;
  }

  Future<List<Routine>> listRoutines(String roleId) async {
    final json = await _request(
      'GET',
      '/roles/${Uri.encodeComponent(roleId)}/routines',
    ) as List<dynamic>;
    return json
        .map((entry) => Routine.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  /// TASK-159 — routine fires are tasks with a real `routineId`; there is no
  /// separate fire-history endpoint/table to query.
  Future<List<RoutineTask>> listRoutineTasks(String routineId) async {
    final json = await _request(
      'GET',
      '/tasks?routineId=${Uri.encodeQueryComponent(routineId)}',
    ) as Map<String, dynamic>;
    return (json['tasks'] as List<dynamic>)
        .map((entry) => RoutineTask.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  /// Returns the actual run rows for one task. Callers display [RoutineRun.status]
  /// as supplied by the API rather than applying a potentially misleading label.
  Future<List<RoutineRun>> listRunsForTask(String taskId) async {
    final json = await _request(
      'GET',
      '/runs?taskId=${Uri.encodeQueryComponent(taskId)}',
    ) as Map<String, dynamic>;
    return (json['runs'] as List<dynamic>)
        .map((entry) => RoutineRun.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  /// TASK-158 (Mobile Wave 8) — `POST /roles/:roleId/routines`
  /// (services/control-api/src/app.ts), body `{name, schedule, definition?}`.
  /// `name` and `schedule` are required non-empty strings; `schedule` is
  /// validated server-side as a real cron expression and rejected with a
  /// 400 (surfaced here as an [ApiException] with the server's message,
  /// same as every other write call). `goal` maps to `definition: {goal}`
  /// — the field `services/worker/src/jobs/routineJob.ts` actually reads
  /// as the created task's instruction — and is omitted entirely (no
  /// `definition` key at all) when the caller passes `null`/empty, rather
  /// than sending `{goal: ""}`.
  Future<Routine> createRoutine(
    String roleId,
    String name,
    String schedule, {
    String? goal,
  }) async {
    final trimmedGoal = goal?.trim();
    final body = <String, dynamic>{
      'name': name,
      'schedule': schedule,
      if (trimmedGoal != null && trimmedGoal.isNotEmpty)
        'definition': {'goal': trimmedGoal},
    };
    final json = await _request(
      'POST',
      '/roles/${Uri.encodeComponent(roleId)}/routines',
      body: body,
    );
    return Routine.fromJson(json as Map<String, dynamic>);
  }

  /// TASK-149 (Mobile Wave 2b) — `POST /devices`, authenticated with the
  /// session cookie like every other call. `platform` must be one of the
  /// wire values `packages/db/src/deviceTokens.ts`'s `devicePlatforms`
  /// accepts (`"android" | "ios" | "web"`) — see
  /// `lib/push/device_platform.dart`. The device token is passed straight
  /// through to the request body and never logged by this method or any
  /// caller.
  Future<void> registerDevice(String token, String platform) async {
    await _request(
      'POST',
      '/devices',
      body: {'token': token, 'platform': platform},
    );
  }

  void close() {
    _client.close();
  }
}
