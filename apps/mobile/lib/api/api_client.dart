import 'dart:convert';

import 'package:http/http.dart' as http;

import 'exceptions.dart';
import 'models.dart';

/// A credential scan refusal deliberately preserves the server's safe
/// diagnostics: the affected JSON-pointer field paths and policy classes,
/// never the credential-like source text.
class TemplateExportRefusedException extends ApiException {
  const TemplateExportRefusedException({
    required this.fieldPaths,
    required this.classes,
  }) : super(
            'Template export was refused because it contains credential-like content.');

  final List<String> fieldPaths;
  final List<String> classes;
}

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
      case 'DELETE':
        response = await _client.delete(uri, headers: _headers(json: false));
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

  // ---- TASK-307: Project Workspace routes (spec §9.1) ----

  static String _id(String value) => Uri.encodeComponent(value);

  static List<T> _parseList<T>(
    dynamic json,
    T Function(Map<String, dynamic>) parse,
  ) =>
      (json as List<dynamic>)
          .map((e) => parse(e as Map<String, dynamic>))
          .toList();

  /// `POST /projects`. Charter fields ([boundaries], [checkWithMeBefore])
  /// are sent at creation (spec §1.2). Roster entries are
  /// `{roleId, responsibility?, isManager?}`. The server's own rejection
  /// (e.g. roster cap) surfaces as [ApiException].
  Future<ProjectWithRoster> createProject({
    required String name,
    required String goal,
    required String doneCriterion,
    String? boundaries,
    String? checkWithMeBefore,
    double? budgetUsd,
    required List<Map<String, Object?>> roster,
  }) async {
    final json = await _request('POST', '/projects', body: {
      'name': name,
      'goal': goal,
      'doneCriterion': doneCriterion,
      if (boundaries != null) 'boundaries': boundaries,
      if (checkWithMeBefore != null) 'checkWithMeBefore': checkWithMeBefore,
      if (budgetUsd != null) 'budgetUsd': budgetUsd,
      'roster': roster,
    });
    return ProjectWithRoster.fromJson(json as Map<String, dynamic>);
  }

  /// `GET /projects` (optionally filtered by status).
  Future<List<Project>> listProjects({String? status}) async {
    final query = status == null ? '' : '?status=${_id(status)}';
    final json = await _request('GET', '/projects$query');
    return _parseList(json, Project.fromJson);
  }

  /// `GET /projects/:id`.
  Future<ProjectDetail> getProject(String projectId) async {
    final json = await _request('GET', '/projects/${_id(projectId)}');
    return ProjectDetail.fromJson(json as Map<String, dynamic>);
  }

  /// `PATCH /projects/:id` — status, budget, roster changes.
  Future<ProjectWithRoster> updateProject(
    String projectId, {
    String? status,
    double? budgetUsd,
    List<Map<String, Object?>>? addMembers,
    List<String>? removeRoleIds,
    String? managerRoleId,
    bool clearManager = false,
  }) async {
    final json = await _request('PATCH', '/projects/${_id(projectId)}', body: {
      if (status != null) 'status': status,
      if (budgetUsd != null) 'budgetUsd': budgetUsd,
      if (addMembers != null) 'addMembers': addMembers,
      if (removeRoleIds != null) 'removeRoleIds': removeRoleIds,
      if (managerRoleId != null) 'managerRoleId': managerRoleId,
      if (clearManager) 'managerRoleId': null,
    });
    return ProjectWithRoster.fromJson(json as Map<String, dynamic>);
  }

  /// `GET /projects/:id/tasks` (optionally filtered by state).
  Future<List<ProjectTask>> listProjectTasks(
    String projectId, {
    String? state,
  }) async {
    final query = state == null ? '' : '?state=${_id(state)}';
    final json =
        await _request('GET', '/projects/${_id(projectId)}/tasks$query');
    return _parseList(json, ProjectTask.fromJson);
  }

  /// `POST /projects/:id/tasks`.
  Future<ProjectTask> createProjectTask(
    String projectId, {
    required String title,
    String? description,
    String? ownerRoleId,
    String? doneCriterion,
    String? state,
    String? blockedReason,
  }) async {
    final json = await _request(
      'POST',
      '/projects/${_id(projectId)}/tasks',
      body: {
        'title': title,
        if (description != null) 'description': description,
        if (ownerRoleId != null) 'ownerRoleId': ownerRoleId,
        if (doneCriterion != null) 'doneCriterion': doneCriterion,
        if (state != null) 'state': state,
        if (blockedReason != null) 'blockedReason': blockedReason,
      },
    );
    return ProjectTask.fromJson(json as Map<String, dynamic>);
  }

  /// `PATCH /projects/:id/tasks/:taskId` — a state transition (blocked needs
  /// [blockedReason]) and/or an owner change.
  Future<ProjectTask> updateProjectTask(
    String projectId,
    String taskId, {
    String? state,
    String? blockedReason,
    String? ownerRoleId,
  }) async {
    final json = await _request(
      'PATCH',
      '/projects/${_id(projectId)}/tasks/${_id(taskId)}',
      body: {
        if (state != null) 'state': state,
        if (blockedReason != null) 'blockedReason': blockedReason,
        if (ownerRoleId != null) 'ownerRoleId': ownerRoleId,
      },
    );
    return ProjectTask.fromJson(json as Map<String, dynamic>);
  }

  /// `GET /projects/:id/artifacts`.
  Future<List<ProjectArtifact>> listProjectArtifacts(String projectId) async {
    final json = await _request('GET', '/projects/${_id(projectId)}/artifacts');
    return _parseList(json, ProjectArtifact.fromJson);
  }

  /// `POST /projects/:id/artifacts` — registers an artifact by reference.
  Future<ProjectArtifact> createProjectArtifact(
    String projectId, {
    required String kind,
    required String ref,
    required String label,
    String? taskId,
    String? sha256,
    int? byteSize,
    String? producedByRoleId,
    String? producedByRunId,
  }) async {
    final json = await _request(
      'POST',
      '/projects/${_id(projectId)}/artifacts',
      body: {
        'kind': kind,
        'ref': ref,
        'label': label,
        if (taskId != null) 'taskId': taskId,
        if (sha256 != null) 'sha256': sha256,
        if (byteSize != null) 'byteSize': byteSize,
        if (producedByRoleId != null) 'producedByRoleId': producedByRoleId,
        if (producedByRunId != null) 'producedByRunId': producedByRunId,
      },
    );
    return ProjectArtifact.fromJson(json as Map<String, dynamic>);
  }

  /// `GET /projects/:id/decisions`.
  Future<List<ProjectDecision>> listProjectDecisions(String projectId) async {
    final json = await _request('GET', '/projects/${_id(projectId)}/decisions');
    return _parseList(json, ProjectDecision.fromJson);
  }

  /// `GET /templates` — lists templates private to the authenticated tenant.
  Future<List<TemplateSummary>> listTemplates() async {
    final json = await _request('GET', '/templates') as List<dynamic>;
    return json
        .map((entry) => TemplateSummary.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  /// `POST /roles/:roleId/templates`. A 422 is intentionally represented by
  /// [TemplateExportRefusedException], so callers can show the server's
  /// field-path/class diagnostics rather than replacing them with a generic
  /// failure message.
  Future<TemplateExportResult> exportRoleTemplate(
    String roleId,
    String name,
  ) async {
    final response = await _client.post(
      Uri.parse('$baseUrl/roles/${Uri.encodeComponent(roleId)}/templates'),
      headers: _headers(),
      body: jsonEncode({'name': name}),
    );
    _captureCookie(response);
    if (response.statusCode == 401) throw const UnauthorizedError();
    if (response.statusCode == 422) {
      final decoded = _jsonObject(response.body);
      throw TemplateExportRefusedException(
        fieldPaths: _stringList(decoded['field_paths']),
        classes: _stringList(decoded['classes']),
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      _throwForError(response, response.body);
    }
    return TemplateExportResult.fromJson(_jsonObject(response.body));
  }

  /// `POST /templates/:id/install` — creates an independent role. Template
  /// integrations are returned only as a checklist; this call does not grant
  /// them.
  Future<TemplateInstallResult> installTemplate(
    String templateId,
    int version, {
    String? name,
  }) async {
    final trimmedName = name?.trim();
    final json = await _request(
      'POST',
      '/templates/${Uri.encodeComponent(templateId)}/install',
      body: {
        'version': version,
        if (trimmedName != null && trimmedName.isNotEmpty) 'name': trimmedName,
      },
    );
    return TemplateInstallResult.fromJson(json as Map<String, dynamic>);
  }

  /// `GET /roles/:roleId/template-status` — reports whether a role was
  /// installed from a template and, if so, which manifest sections changed.
  Future<TemplateStatus> getRoleTemplateStatus(String roleId) async {
    final json = await _request(
      'GET',
      '/roles/${Uri.encodeComponent(roleId)}/template-status',
    );
    return TemplateStatus.fromJson(json as Map<String, dynamic>);
  }

  static Map<String, dynamic> _jsonObject(String body) {
    final decoded = jsonDecode(body);
    if (decoded is! Map<String, dynamic>) {
      throw const ApiException('server returned an invalid response');
    }
    return decoded;
  }

  static List<String> _stringList(dynamic value) {
    return value is List ? value.whereType<String>().toList() : const [];
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

  /// Records that the authenticated viewer has opened a thread. The server
  /// accepts an optional message cursor, but opening the mobile chat marks at
  /// its current time so newly-arriving messages remain unread.
  Future<void> markThreadRead(String threadId) async {
    await _request('POST', '/threads/${_id(threadId)}/read');
  }

  /// Pins a thread for the authenticated viewer and returns its server time.
  Future<String?> pinThread(String threadId) async {
    final json = await _request('PUT', '/threads/${_id(threadId)}/pin')
        as Map<String, dynamic>;
    return json['pinnedAt'] as String?;
  }

  /// Removes the authenticated viewer's pin from a thread.
  Future<void> unpinThread(String threadId) async {
    await _request('DELETE', '/threads/${_id(threadId)}/pin');
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

  Future<ThreadContext> getThreadContext(String threadId) async {
    final json = await _request(
      'GET',
      '/threads/${Uri.encodeComponent(threadId)}',
    ) as Map<String, dynamic>;
    return ThreadContext.fromJson(json);
  }

  Future<ThreadContext> startFresh(String threadId) async {
    final json = await _request(
      'POST',
      '/threads/${Uri.encodeComponent(threadId)}/fresh',
    ) as Map<String, dynamic>;
    return ThreadContext.fromJson(json);
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

  /// TASK-187 (G-05b) — provides the requested secret value. The server
  /// response carries only an opaque vault ref; `value` itself is never
  /// stored, logged, or included in analytics on this client (non-negotiable
  /// 4). A 404 means the request was already decided (fulfilled/declined)
  /// or belongs to a different tenant — callers should disable the card,
  /// same as [decideApproval]'s 409 handling.
  Future<String?> fulfilSecretRequest(String requestId, String value) async {
    final uri = Uri.parse(
      '$baseUrl/secret-requests/${Uri.encodeComponent(requestId)}/fulfil',
    );
    final response = await _client.post(
      uri,
      headers: _headers(),
      body: jsonEncode({'value': value}),
    );
    _captureCookie(response);
    if (response.statusCode == 404) return null;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      _throwForError(response, response.body);
    }
    final decoded = jsonDecode(response.body) as Map<String, dynamic>;
    return decoded['ref'] as String;
  }

  /// Declines a secret request. A 404 means it was already decided or
  /// belongs to a different tenant — same "disable the card" contract as
  /// [fulfilSecretRequest]'s null return.
  Future<bool> declineSecretRequest(String requestId) async {
    final uri = Uri.parse(
      '$baseUrl/secret-requests/${Uri.encodeComponent(requestId)}/decline',
    );
    final response = await _client.post(uri, headers: _headers());
    _captureCookie(response);
    if (response.statusCode == 404) return false;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      _throwForError(response, response.body);
    }
    return true;
  }

  /// TASK-235 (G-07 part 2b) — `GET /runs/:id/takeover`. A `501` (no
  /// `TakeoverPort` configured server-side — see that route's own doc
  /// comment) and a `404` (run not found/not owned) are both treated as
  /// "nothing pending" rather than surfaced as errors: from the caller's
  /// perspective (polling for a card to show) both mean the same thing.
  Future<TakeoverStatus> getTakeoverStatus(String runId) async {
    final uri =
        Uri.parse('$baseUrl/runs/${Uri.encodeComponent(runId)}/takeover');
    final response = await _client.get(uri, headers: _headers(json: false));
    _captureCookie(response);
    if (response.statusCode == 501 || response.statusCode == 404) {
      return const TakeoverStatus(pending: false);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      _throwForError(response, response.body);
    }
    final decoded = jsonDecode(response.body) as Map<String, dynamic>;
    return TakeoverStatus.fromJson(decoded);
  }

  /// TASK-235 (G-07 part 2b) — `POST /runs/:id/takeover/complete`. A `409`
  /// means the run was no longer pending (already handed back, or never
  /// was) — returns `false` rather than throwing, same "disable the
  /// action, don't show an error" contract [decideApproval] established.
  Future<bool> completeTakeover(String runId) async {
    final uri = Uri.parse(
      '$baseUrl/runs/${Uri.encodeComponent(runId)}/takeover/complete',
    );
    final response = await _client.post(uri, headers: _headers());
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
    String? skillId,
  }) async {
    final trimmedGoal = goal?.trim();
    final body = <String, dynamic>{
      'name': name,
      'schedule': schedule,
      if (trimmedGoal != null && trimmedGoal.isNotEmpty)
        'definition': {'goal': trimmedGoal},
      if (skillId != null) 'skillId': skillId,
    };
    final json = await _request(
      'POST',
      '/roles/${Uri.encodeComponent(roleId)}/routines',
      body: body,
    );
    return Routine.fromJson(json as Map<String, dynamic>);
  }

  Future<Routine> setRoutinePaused(String routineId, bool paused) async {
    final json = await _request(
      'POST',
      '/routines/${Uri.encodeComponent(routineId)}/${paused ? 'pause' : 'resume'}',
    ) as Map<String, dynamic>;
    return Routine.fromJson(json);
  }

  Future<RoutineTestRun> testRunRoutine(String routineId) async {
    final json = await _request(
      'POST',
      '/routines/${Uri.encodeComponent(routineId)}/test-run',
    ) as Map<String, dynamic>;
    return RoutineTestRun.fromJson(json);
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
