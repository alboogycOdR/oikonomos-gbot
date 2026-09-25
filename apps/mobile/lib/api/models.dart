/// TASK-144 (Mobile Wave 1a) — wire shapes mirroring
/// `apps/dashboard/src/lib/api.ts` exactly for the subset of endpoints this
/// task covers: roles, threads (including group threads), thread
/// messages. Field names match the server's real JSON serialization
/// (`services/control-api/src/app.ts`), same convention the TS client
/// uses (e.g. `action_render`, `capability_id` stay snake_case inside the
/// nested `approval` object because that is what the server sends).
library;

/// Stable avatar tokens accepted by the API. Keeping these token strings (not
/// their visual values) in the wire model lets older clients safely ignore
/// newly added or malformed values.
const avatarColorTokens = <String>[
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'violet',
  'pink',
];

const avatarShapeTokens = <String>[
  'circle',
  'square',
  'rounded',
  'hexagon',
  'diamond',
  'star',
  'triangle',
  'teardrop',
];

String? _avatarToken(Object? value, List<String> tokens) =>
    value is String && tokens.contains(value) ? value : null;

class Role {
  const Role({
    required this.id,
    required this.name,
    required this.description,
    required this.avatarSeed,
    this.title,
    this.instructions,
    this.avatarColor,
    this.avatarShape,
  });

  final String id;
  final String name;
  final String description;
  final String avatarSeed;

  /// Display title from `serializeRole`. Null when the bot has none.
  final String? title;

  /// Custom system-prompt material. Null means none configured; PATCH
  /// `/roles/:roleId` requires `instructions` and treats `""` as clear.
  final String? instructions;
  final String? avatarColor;
  final String? avatarShape;

  factory Role.fromJson(Map<String, dynamic> json) {
    return Role(
      id: json['id'] as String,
      name: json['name'] as String,
      description: json['description'] as String,
      avatarSeed: json['avatarSeed'] as String,
      title: json['title'] as String?,
      instructions: json['instructions'] as String?,
      avatarColor: _avatarToken(json['avatarColor'], avatarColorTokens),
      avatarShape: _avatarToken(json['avatarShape'], avatarShapeTokens),
    );
  }
}

/// A granted capability returned by `GET /roles/:roleId/grants`.
class RoleGrant {
  const RoleGrant({
    required this.roleId,
    required this.capabilityId,
    required this.maxTier,
    required this.constraints,
  });

  final String roleId;
  final String capabilityId;
  final String maxTier;
  final Map<String, dynamic> constraints;

  factory RoleGrant.fromJson(Map<String, dynamic> json) => RoleGrant(
        roleId: json['roleId'] as String,
        capabilityId: json['capabilityId'] as String,
        maxTier: json['maxTier'] as String,
        constraints: json['constraints'] is Map<String, dynamic>
            ? json['constraints'] as Map<String, dynamic>
            : const {},
      );
}

/// Connector-grouped capability catalog returned by `GET /roles/:roleId/tools`.
class RoleToolCatalog {
  const RoleToolCatalog({required this.systems});

  final List<RoleToolSystem> systems;

  factory RoleToolCatalog.fromJson(Map<String, dynamic> json) =>
      RoleToolCatalog(
        systems: (json['systems'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(RoleToolSystem.fromJson)
            .toList(),
      );
}

class RoleToolSystem {
  const RoleToolSystem({
    required this.id,
    required this.label,
    required this.tools,
  });

  final String id;
  final String label;
  final List<RoleTool> tools;

  factory RoleToolSystem.fromJson(Map<String, dynamic> json) => RoleToolSystem(
        id: json['id'] as String,
        label: json['label'] as String,
        tools: (json['tools'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(RoleTool.fromJson)
            .toList(),
      );
}

class RoleTool {
  const RoleTool({
    required this.id,
    required this.label,
    required this.description,
    required this.defaultTier,
    required this.granted,
    required this.grantable,
    this.maxTier,
  });

  final String id;
  final String label;
  final String description;
  final String defaultTier;
  final bool granted;
  final String? maxTier;
  final bool grantable;

  factory RoleTool.fromJson(Map<String, dynamic> json) => RoleTool(
        id: json['id'] as String,
        label: json['label'] as String,
        description: json['description'] as String,
        defaultTier: json['defaultTier'] as String,
        granted: json['granted'] as bool? ?? false,
        maxTier: json['maxTier'] as String?,
        grantable: json['grantable'] as bool? ?? false,
      );
}

/// One role-scoped Require-Approval rule exposed by the Auto-review API.
class ReviewRule {
  const ReviewRule({
    required this.ruleId,
    required this.capabilityId,
    required this.enabled,
    this.createdBy,
  });

  final String ruleId;
  final String capabilityId;
  final bool enabled;
  final String? createdBy;

  bool get isAutoCreated => createdBy == 'auto-review';

  factory ReviewRule.fromJson(Map<String, dynamic> json) => ReviewRule(
        ruleId: json['ruleId'] as String,
        capabilityId: json['capabilityId'] as String,
        enabled: json['enabled'] as bool? ?? false,
        createdBy: json['createdBy'] as String?,
      );
}

/// `GET` and `PUT /roles/:roleId/auto-review` response body.
class AutoReviewSettings {
  const AutoReviewSettings({required this.enabled, required this.rules});

  final bool enabled;
  final List<ReviewRule> rules;

  factory AutoReviewSettings.fromJson(Map<String, dynamic> json) =>
      AutoReviewSettings(
        enabled: json['enabled'] as bool? ?? false,
        rules: (json['rules'] as List<dynamic>? ?? const [])
            .map((rule) => ReviewRule.fromJson(rule as Map<String, dynamic>))
            .toList(),
      );
}

/// A reusable, account-scoped procedure returned by the Skills API.
class Skill {
  const Skill({
    required this.id,
    required this.name,
    required this.description,
    required this.body,
    this.whenToUse,
    this.approvals = const [],
    this.status = 'active',
  });

  final String id;
  final String name;
  final String description;
  final String body;
  final String? whenToUse;
  final List<String> approvals;
  final String status;

  factory Skill.fromJson(Map<String, dynamic> json) => Skill(
        id: json['skillId'] as String,
        name: json['name'] as String,
        description: json['description'] as String,
        body: json['body'] as String,
        whenToUse: json['whenToUse'] as String?,
        approvals: (json['approvals'] as List<dynamic>? ?? const [])
            .whereType<String>()
            .toList(),
        status: json['status'] as String? ?? 'active',
      );
}

/// Base type for the discriminated `Thread | GroupThread` union `GET
/// /threads` returns. Mirrors `isGroupThread` in `api.ts`: a group thread
/// is identified by the presence of `memberRoleIds` in the raw JSON, never
/// by a null `roleId` on a single-role thread.
sealed class ThreadSummary {
  const ThreadSummary({
    required this.id,
    required this.title,
    required this.lastMessagePreview,
    required this.updatedAt,
    this.previewText,
    this.previewAuthorKind,
    this.lastMessageAt,
    this.unreadCount = 0,
    this.pinnedAt,
  });

  final String id;
  final String? title;
  final String lastMessagePreview;
  final String updatedAt;

  /// TASK-331/332 — additive roster fields; all null when an older server
  /// omits them (or sends null for a thread with no messages).
  final String? previewText;
  final String? previewAuthorKind;
  final String? lastMessageAt;

  /// TASK-334 — viewer-specific state added by the read-marker API. Older
  /// servers omit both fields, which deliberately remains equivalent to an
  /// unpinned thread with no unread messages.
  final int unreadCount;
  final String? pinnedAt;

  /// Preview to show: the new `preview.text`, else the legacy string.
  String get displayPreview {
    final text = previewText;
    if (text != null && text.trim().isNotEmpty) return text;
    return lastMessagePreview;
  }

  /// Timestamp for the relative time: `lastMessageAt`, else `updatedAt`.
  String get displayTime => lastMessageAt ?? updatedAt;

  static ({String? text, String? authorKind}) _parsePreview(Object? raw) {
    if (raw is! Map) return (text: null, authorKind: null);
    final text = raw['text'];
    final kind = raw['authorKind'];
    return (
      text: text is String ? text : null,
      authorKind: kind is String ? kind : null,
    );
  }

  static String? _optString(Object? raw) => raw is String ? raw : null;

  static ThreadSummary fromJson(Map<String, dynamic> json) {
    if (json.containsKey('memberRoleIds')) {
      return GroupThread.fromJson(json);
    }
    return SingleThread.fromJson(json);
  }
}

class SingleThread extends ThreadSummary {
  const SingleThread({
    required super.id,
    required this.roleId,
    required this.botName,
    required this.botDescription,
    required this.avatarSeed,
    required super.title,
    required super.lastMessagePreview,
    required super.updatedAt,
    super.previewText,
    super.previewAuthorKind,
    super.lastMessageAt,
    super.unreadCount,
    super.pinnedAt,
    this.avatarColor,
    this.avatarShape,
  });

  final String roleId;
  final String botName;
  final String botDescription;
  final String avatarSeed;
  final String? avatarColor;
  final String? avatarShape;

  factory SingleThread.fromJson(Map<String, dynamic> json) {
    return SingleThread(
      id: json['id'] as String,
      roleId: json['roleId'] as String,
      botName: json['botName'] as String,
      botDescription: json['botDescription'] as String,
      avatarSeed: json['avatarSeed'] as String,
      title: json['title'] as String?,
      lastMessagePreview: json['lastMessagePreview'] as String? ?? '',
      updatedAt: json['updatedAt'] as String,
      previewText: ThreadSummary._parsePreview(json['preview']).text,
      previewAuthorKind:
          ThreadSummary._parsePreview(json['preview']).authorKind,
      lastMessageAt: ThreadSummary._optString(json['lastMessageAt']),
      unreadCount: json['unreadCount'] is int && json['unreadCount'] >= 0
          ? json['unreadCount'] as int
          : 0,
      pinnedAt: ThreadSummary._optString(json['pinnedAt']),
      avatarColor: _avatarToken(json['avatarColor'], avatarColorTokens),
      avatarShape: _avatarToken(json['avatarShape'], avatarShapeTokens),
    );
  }
}

class GroupThread extends ThreadSummary {
  const GroupThread({
    required super.id,
    required this.memberRoleIds,
    required this.memberNames,
    required super.title,
    required super.lastMessagePreview,
    required super.updatedAt,
    super.previewText,
    super.previewAuthorKind,
    super.lastMessageAt,
    super.unreadCount,
    super.pinnedAt,
  });

  final List<String> memberRoleIds;
  final List<String> memberNames;

  factory GroupThread.fromJson(Map<String, dynamic> json) {
    return GroupThread(
      id: json['id'] as String,
      memberRoleIds: (json['memberRoleIds'] as List<dynamic>).cast<String>(),
      memberNames: (json['memberNames'] as List<dynamic>).cast<String>(),
      title: json['title'] as String?,
      lastMessagePreview: json['lastMessagePreview'] as String? ?? '',
      updatedAt: json['updatedAt'] as String,
      previewText: ThreadSummary._parsePreview(json['preview']).text,
      previewAuthorKind:
          ThreadSummary._parsePreview(json['preview']).authorKind,
      lastMessageAt: ThreadSummary._optString(json['lastMessageAt']),
      unreadCount: json['unreadCount'] is int && json['unreadCount'] >= 0
          ? json['unreadCount'] as int
          : 0,
      pinnedAt: ThreadSummary._optString(json['pinnedAt']),
    );
  }
}

class ApprovalRef {
  const ApprovalRef({
    required this.nonce,
    required this.actionRender,
    required this.status,
    required this.capabilityId,
    required this.maxTier,
  });

  final String nonce;
  final String actionRender;
  final String status;
  final String capabilityId;
  final String? maxTier;

  factory ApprovalRef.fromJson(Map<String, dynamic> json) {
    return ApprovalRef(
      nonce: json['nonce'] as String,
      actionRender: json['action_render'] as String,
      status: json['status'] as String,
      capabilityId: json['capability_id'] as String,
      maxTier: json['max_tier'] as String?,
    );
  }
}

/// TASK-187 (G-05b) — the nested `secretRequest` object `GET
/// /threads/:id/messages` and the SSE stream attach to the message tied to
/// the run that requested it (`services/control-api/src/app.ts`'s
/// `shapeMessage`), same convention as [ApprovalRef] above: snake_case keys
/// because that is what the server sends.
class SecretRequestRef {
  const SecretRequestRef({
    required this.requestId,
    required this.label,
    required this.purpose,
    required this.status,
  });

  final String requestId;
  final String label;
  final String purpose;
  final String status;

  factory SecretRequestRef.fromJson(Map<String, dynamic> json) {
    return SecretRequestRef(
      requestId: json['request_id'] as String,
      label: json['label'] as String,
      purpose: json['purpose'] as String,
      status: json['status'] as String,
    );
  }
}

/// TASK-235 (G-07 part 2b) — `GET /runs/:id/takeover`'s response shape,
/// mirroring `services/control-api/src/app.ts`'s `TakeoverStatus` interface
/// exactly (camelCase — this route, unlike `ApprovalRef`/`SecretRequestRef`
/// above, was never a nested nested-in-message shape with its own
/// snake_case history; it is fetched directly).
class TakeoverStatus {
  const TakeoverStatus({required this.pending, this.kind, this.detail});

  final bool pending;

  /// One of `captcha` / `two_factor` / `login_wall` / `payment` when
  /// [pending] is true — the same vocabulary [TakeoverCard] already
  /// switches on.
  final String? kind;
  final String? detail;

  factory TakeoverStatus.fromJson(Map<String, dynamic> json) {
    return TakeoverStatus(
      pending: json['pending'] as bool,
      kind: json['kind'] as String?,
      detail: json['detail'] as String?,
    );
  }
}

/// A scheduled routine returned by `GET /roles/:roleId/routines`.
class Routine {
  const Routine({
    required this.id,
    required this.name,
    required this.schedule,
    required this.lastFireAt,
    required this.nextFireAt,
    required this.paused,
    this.skillId,
  });

  final String id;
  final String name;
  final String? schedule;
  final String? lastFireAt;
  final String? nextFireAt;
  final bool paused;
  final String? skillId;

  factory Routine.fromJson(Map<String, dynamic> json) {
    return Routine(
      id: json['routineId'] as String,
      name: json['name'] as String,
      schedule: json['schedule'] as String?,
      lastFireAt: json['lastFireAt'] as String?,
      nextFireAt: json['nextFireAt'] as String?,
      paused: json['paused'] as bool? ?? false,
      skillId: json['skillId'] as String?,
    );
  }
}

/// The live context accounting for one thread.  This is deliberately kept
/// separate from [ThreadSummary]: the list endpoint does not return it.
class ThreadContext {
  const ThreadContext({
    required this.contextTokens,
    required this.contextLimit,
    required this.epoch,
  });

  final int contextTokens;
  final int contextLimit;
  final int epoch;

  factory ThreadContext.fromJson(Map<String, dynamic> json) => ThreadContext(
        contextTokens: json['contextTokens'] as int,
        contextLimit: json['contextLimit'] as int,
        epoch: json['epoch'] as int,
      );
}

class RoutineTestRun {
  const RoutineTestRun({required this.routine, required this.warning});

  final Routine routine;
  final String warning;

  factory RoutineTestRun.fromJson(Map<String, dynamic> json) => RoutineTestRun(
        routine: Routine.fromJson(json['routine'] as Map<String, dynamic>),
        warning: json['warning'] as String,
      );
}

/// The subset of a task used to reconstruct a routine's fire history.
class RoutineTask {
  const RoutineTask({required this.id});

  final String id;

  factory RoutineTask.fromJson(Map<String, dynamic> json) {
    return RoutineTask(id: json['taskId'] as String);
  }
}

/// A real run returned by `GET /runs?taskId=...`; [status] is deliberately
/// kept verbatim so the UI never recasts a failure as a successful outcome.
class RoutineRun {
  const RoutineRun({required this.status, required this.startedAt});

  final String status;
  final String startedAt;

  factory RoutineRun.fromJson(Map<String, dynamic> json) {
    return RoutineRun(
      status: json['status'] as String,
      startedAt: json['startedAt'] as String,
    );
  }
}

class MessageAttachment {
  const MessageAttachment({
    required this.id,
    required this.filename,
    required this.contentType,
    required this.byteSize,
    required this.sha256,
  });

  final String id;
  final String filename;
  final String contentType;
  final int byteSize;
  final String sha256;

  factory MessageAttachment.fromJson(Map<String, dynamic> json) {
    return MessageAttachment(
      id: json['id'] as String,
      filename: json['filename'] as String,
      contentType: json['contentType'] as String,
      byteSize: json['byteSize'] as int,
      sha256: json['sha256'] as String,
    );
  }
}

class ThreadMessage {
  const ThreadMessage({
    required this.id,
    required this.threadId,
    required this.role,
    required this.body,
    required this.runId,
    required this.createdAt,
    this.senderRoleId,
    this.senderName,
    this.approval,
    this.secretRequest,
    this.attachments = const [],
  });

  final String id;
  final String threadId;
  final String role;
  final String body;
  final String? runId;
  final String createdAt;
  final String? senderRoleId;
  final String? senderName;
  final ApprovalRef? approval;
  final SecretRequestRef? secretRequest;
  final List<MessageAttachment> attachments;

  factory ThreadMessage.fromJson(Map<String, dynamic> json) {
    final rawAttachments = json['attachments'];
    return ThreadMessage(
      id: json['id'] as String,
      threadId: json['threadId'] as String,
      role: json['role'] as String,
      body: json['body'] as String,
      runId: json['runId'] as String?,
      createdAt: json['createdAt'] as String,
      senderRoleId: json['senderRoleId'] as String?,
      senderName: json['senderName'] as String?,
      approval: json['approval'] == null
          ? null
          : ApprovalRef.fromJson(json['approval'] as Map<String, dynamic>),
      secretRequest: json['secretRequest'] == null
          ? null
          : SecretRequestRef.fromJson(
              json['secretRequest'] as Map<String, dynamic>,
            ),
      attachments: rawAttachments is List
          ? rawAttachments
              .whereType<Map<String, dynamic>>()
              .map(MessageAttachment.fromJson)
              .toList()
          : const [],
    );
  }
}

/// A real async role-to-role handoff returned by `GET /roles/:roleId/messages`.
class RoleHandoff {
  const RoleHandoff({
    required this.id,
    required this.fromRoleId,
    required this.toRoleId,
    required this.body,
    required this.createdAt,
  });

  final String id;
  final String fromRoleId;
  final String toRoleId;
  final String body;
  final String createdAt;

  factory RoleHandoff.fromJson(Map<String, dynamic> json) => RoleHandoff(
        id: json['messageId'] as String,
        fromRoleId: json['fromRoleId'] as String,
        toRoleId: json['toRoleId'] as String,
        body: json['body'] as String,
        createdAt: json['createdAt'] as String,
      );
}

/// A tenant-scoped template returned by `GET /templates`.
class TemplateSummary {
  const TemplateSummary({
    required this.templateId,
    required this.version,
    required this.name,
    required this.digest,
  });

  final String templateId;
  final int version;
  final String name;
  final String digest;

  factory TemplateSummary.fromJson(Map<String, dynamic> json) {
    return TemplateSummary(
      templateId: json['templateId'] as String,
      version: json['version'] as int,
      name: json['name'] as String,
      digest: json['digest'] as String,
    );
  }
}

/// The success response from `POST /roles/:roleId/templates`.
class TemplateExportResult {
  const TemplateExportResult({
    required this.templateId,
    required this.version,
    required this.digest,
  });

  final String templateId;
  final int version;
  final String digest;

  factory TemplateExportResult.fromJson(Map<String, dynamic> json) {
    return TemplateExportResult(
      templateId: json['templateId'] as String,
      version: json['version'] as int,
      digest: json['digest'] as String,
    );
  }
}

/// An integration a human may choose to grant after template installation.
class GrantChecklistEntry {
  const GrantChecklistEntry({
    required this.capabilityId,
    required this.requestedMaxTier,
    required this.status,
  });

  final String capabilityId;
  final String requestedMaxTier;

  /// One of `available`, `unknown_capability`, or `disabled`.
  final String status;

  factory GrantChecklistEntry.fromJson(Map<String, dynamic> json) {
    return GrantChecklistEntry(
      capabilityId: json['capability_id'] as String,
      requestedMaxTier: json['requested_max_tier'] as String,
      status: json['status'] as String,
    );
  }
}

/// The role and manual-grant checklist returned after installing a template.
class TemplateInstallResult {
  const TemplateInstallResult({
    required this.roleId,
    required this.grantChecklist,
    required this.next,
  });

  final String roleId;
  final List<GrantChecklistEntry> grantChecklist;
  final String next;

  factory TemplateInstallResult.fromJson(Map<String, dynamic> json) {
    final role = json['role'] as Map<String, dynamic>;
    final checklist = json['grant_checklist'] as List<dynamic>? ?? const [];
    return TemplateInstallResult(
      roleId: role['roleId'] as String,
      grantChecklist: checklist
          .whereType<Map<String, dynamic>>()
          .map(GrantChecklistEntry.fromJson)
          .toList(),
      next: json['next'] as String? ?? '',
    );
  }
}

/// The install origin and drift state returned by
/// `GET /roles/:roleId/template-status`.
///
/// A null [installedFrom] deliberately means the role was never installed
/// from a template, rather than an unavailable status result.
class TemplateStatus {
  const TemplateStatus({
    required this.installedFrom,
    required this.drift,
    required this.changed,
  });

  final TemplateInstallSource? installedFrom;
  final bool drift;
  final List<String> changed;

  factory TemplateStatus.fromJson(Map<String, dynamic> json) {
    final installedFrom = json['installed_from'];
    return TemplateStatus(
      installedFrom: installedFrom is Map<String, dynamic>
          ? TemplateInstallSource.fromJson(installedFrom)
          : null,
      drift: json['drift'] as bool? ?? false,
      changed: (json['changed'] as List<dynamic>? ?? const [])
          .whereType<String>()
          .toList(),
    );
  }
}

/// Identifies the immutable template version from which a role was installed.
class TemplateInstallSource {
  const TemplateInstallSource({
    required this.templateId,
    required this.version,
  });

  final String templateId;
  final int version;

  factory TemplateInstallSource.fromJson(Map<String, dynamic> json) {
    return TemplateInstallSource(
      templateId: json['templateId'] as String,
      version: json['version'] as int,
    );
  }
}

/// TASK-307 — Project Workspace wire shapes (spec §9.1), mirroring
/// `services/control-api/src/projects.ts` serializers.
const projectTaskStates = [
  'todo',
  'doing',
  'blocked',
  'review',
  'done',
  'cancelled',
];

/// Human-permitted transitions (spec §3.1), same table as the server's.
const projectTaskTransitions = <String, List<String>>{
  'todo': ['doing', 'cancelled'],
  'doing': ['review', 'blocked', 'cancelled'],
  'blocked': ['doing', 'cancelled'],
  'review': ['done', 'doing', 'cancelled'],
  'done': [],
  'cancelled': [],
};

class ProjectMember {
  const ProjectMember({
    required this.roleId,
    required this.isManager,
    required this.responsibility,
  });

  final String roleId;
  final bool isManager;
  final String responsibility;

  factory ProjectMember.fromJson(Map<String, dynamic> json) => ProjectMember(
        roleId: json['roleId'] as String,
        isManager: json['isManager'] as bool? ?? false,
        responsibility: json['responsibility'] as String? ?? '',
      );
}

class Project {
  const Project({
    required this.projectId,
    required this.threadId,
    required this.name,
    required this.goal,
    required this.doneCriterion,
    required this.status,
    required this.budgetUsd,
    required this.createdBy,
    required this.createdAt,
    required this.updatedAt,
  });

  final String projectId;
  final String threadId;
  final String name;
  final String goal;
  final String doneCriterion;
  final String status;
  final double? budgetUsd;
  final String createdBy;
  final String createdAt;
  final String updatedAt;

  factory Project.fromJson(Map<String, dynamic> json) => Project(
        projectId: json['projectId'] as String,
        threadId: json['threadId'] as String,
        name: json['name'] as String,
        goal: json['goal'] as String,
        doneCriterion: json['doneCriterion'] as String,
        status: json['status'] as String,
        budgetUsd: (json['budgetUsd'] as num?)?.toDouble(),
        createdBy: json['createdBy'] as String? ?? '',
        createdAt: json['createdAt'] as String? ?? '',
        updatedAt: json['updatedAt'] as String? ?? '',
      );
}

/// Response of `POST /projects` and `PATCH /projects/:id`.
class ProjectWithRoster {
  const ProjectWithRoster({required this.project, required this.roster});

  final Project project;
  final List<ProjectMember> roster;

  factory ProjectWithRoster.fromJson(Map<String, dynamic> json) =>
      ProjectWithRoster(
        project: Project.fromJson(json['project'] as Map<String, dynamic>),
        roster: (json['roster'] as List<dynamic>)
            .map((e) => ProjectMember.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class ProjectArtifact {
  const ProjectArtifact({
    required this.artifactId,
    required this.projectId,
    required this.taskId,
    required this.kind,
    required this.ref,
    required this.sha256,
    required this.byteSize,
    required this.producedByRoleId,
    required this.producedByRunId,
    required this.label,
    required this.createdAt,
  });

  final String artifactId;
  final String projectId;
  final String? taskId;
  final String kind;
  final String ref;
  final String? sha256;
  final int? byteSize;
  final String? producedByRoleId;
  final String? producedByRunId;
  final String label;
  final String createdAt;

  factory ProjectArtifact.fromJson(Map<String, dynamic> json) =>
      ProjectArtifact(
        artifactId: json['artifactId'] as String,
        projectId: json['projectId'] as String,
        taskId: json['taskId'] as String?,
        kind: json['kind'] as String,
        ref: json['ref'] as String,
        sha256: json['sha256'] as String?,
        byteSize: (json['byteSize'] as num?)?.toInt(),
        producedByRoleId: json['producedByRoleId'] as String?,
        producedByRunId: json['producedByRunId'] as String?,
        label: json['label'] as String,
        createdAt: json['createdAt'] as String? ?? '',
      );
}

/// `GET /projects/:id` — project plus charter, roster, board counts,
/// latest STATUS.md artifact and spend.
class ProjectDetail {
  const ProjectDetail({
    required this.project,
    required this.charter,
    required this.roster,
    required this.board,
    required this.latestStatusArtifact,
    required this.spendUsd,
  });

  final Project project;
  final Map<String, String> charter;
  final List<ProjectMember> roster;
  final Map<String, int> board;
  final ProjectArtifact? latestStatusArtifact;
  final double spendUsd;

  factory ProjectDetail.fromJson(Map<String, dynamic> json) {
    final status = json['latestStatusArtifact'];
    final spend = json['spend'] as Map<String, dynamic>?;
    return ProjectDetail(
      project: Project.fromJson(json),
      charter: ((json['charter'] as Map<String, dynamic>?) ?? const {})
          .map((k, v) => MapEntry(k, v.toString())),
      roster: ((json['roster'] as List<dynamic>?) ?? const [])
          .map((e) => ProjectMember.fromJson(e as Map<String, dynamic>))
          .toList(),
      board: ((json['board'] as Map<String, dynamic>?) ?? const {})
          .map((k, v) => MapEntry(k, (v as num).toInt())),
      latestStatusArtifact: status == null
          ? null
          : ProjectArtifact.fromJson(status as Map<String, dynamic>),
      spendUsd: (spend?['usd'] as num?)?.toDouble() ?? 0,
    );
  }
}

class ProjectTask {
  const ProjectTask({
    required this.taskId,
    required this.projectId,
    required this.title,
    required this.description,
    required this.ownerRoleId,
    required this.state,
    required this.blockedReason,
    required this.doneCriterion,
    required this.createdBy,
    required this.createdAt,
    required this.updatedAt,
  });

  final String taskId;
  final String projectId;
  final String title;
  final String description;
  final String? ownerRoleId;
  final String state;
  final String? blockedReason;
  final String? doneCriterion;
  final String createdBy;
  final String createdAt;
  final String updatedAt;

  factory ProjectTask.fromJson(Map<String, dynamic> json) => ProjectTask(
        taskId: json['taskId'] as String,
        projectId: json['projectId'] as String,
        title: json['title'] as String,
        description: json['description'] as String? ?? '',
        ownerRoleId: json['ownerRoleId'] as String?,
        state: json['state'] as String,
        blockedReason: json['blockedReason'] as String?,
        doneCriterion: json['doneCriterion'] as String?,
        createdBy: json['createdBy'] as String? ?? '',
        createdAt: json['createdAt'] as String? ?? '',
        updatedAt: json['updatedAt'] as String? ?? '',
      );
}

class ProjectDecision {
  const ProjectDecision({
    required this.decisionId,
    required this.projectId,
    required this.taskId,
    required this.kind,
    required this.approvalId,
    required this.summary,
    required this.actor,
    required this.createdAt,
  });

  final String decisionId;
  final String projectId;
  final String? taskId;
  final String kind;
  final String? approvalId;
  final String summary;
  final String actor;
  final String createdAt;

  factory ProjectDecision.fromJson(Map<String, dynamic> json) =>
      ProjectDecision(
        decisionId: json['decisionId'] as String,
        projectId: json['projectId'] as String,
        taskId: json['taskId'] as String?,
        kind: json['kind'] as String,
        approvalId: json['approvalId'] as String?,
        summary: json['summary'] as String,
        actor: json['actor'] as String? ?? '',
        createdAt: json['createdAt'] as String? ?? '',
      );
}
