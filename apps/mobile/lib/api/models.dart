/// TASK-144 (Mobile Wave 1a) — wire shapes mirroring
/// `apps/dashboard/src/lib/api.ts` exactly for the subset of endpoints this
/// task covers: roles, threads (including group threads), thread
/// messages. Field names match the server's real JSON serialization
/// (`services/control-api/src/app.ts`), same convention the TS client
/// uses (e.g. `action_render`, `capability_id` stay snake_case inside the
/// nested `approval` object because that is what the server sends).
library;

class Role {
  const Role({
    required this.id,
    required this.name,
    required this.description,
    required this.avatarSeed,
  });

  final String id;
  final String name;
  final String description;
  final String avatarSeed;

  factory Role.fromJson(Map<String, dynamic> json) {
    return Role(
      id: json['id'] as String,
      name: json['name'] as String,
      description: json['description'] as String,
      avatarSeed: json['avatarSeed'] as String,
    );
  }
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
  });

  final String id;
  final String? title;
  final String lastMessagePreview;
  final String updatedAt;

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
  });

  final String roleId;
  final String botName;
  final String botDescription;
  final String avatarSeed;

  factory SingleThread.fromJson(Map<String, dynamic> json) {
    return SingleThread(
      id: json['id'] as String,
      roleId: json['roleId'] as String,
      botName: json['botName'] as String,
      botDescription: json['botDescription'] as String,
      avatarSeed: json['avatarSeed'] as String,
      title: json['title'] as String?,
      lastMessagePreview: json['lastMessagePreview'] as String,
      updatedAt: json['updatedAt'] as String,
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
  });

  final List<String> memberRoleIds;
  final List<String> memberNames;

  factory GroupThread.fromJson(Map<String, dynamic> json) {
    return GroupThread(
      id: json['id'] as String,
      memberRoleIds: (json['memberRoleIds'] as List<dynamic>).cast<String>(),
      memberNames: (json['memberNames'] as List<dynamic>).cast<String>(),
      title: json['title'] as String?,
      lastMessagePreview: json['lastMessagePreview'] as String,
      updatedAt: json['updatedAt'] as String,
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

/// A scheduled routine returned by `GET /roles/:roleId/routines`.
class Routine {
  const Routine({
    required this.id,
    required this.name,
    required this.schedule,
    required this.lastFireAt,
    required this.nextFireAt,
  });

  final String id;
  final String name;
  final String? schedule;
  final String? lastFireAt;
  final String? nextFireAt;

  factory Routine.fromJson(Map<String, dynamic> json) {
    return Routine(
      id: json['routineId'] as String,
      name: json['name'] as String,
      schedule: json['schedule'] as String?,
      lastFireAt: json['lastFireAt'] as String?,
      nextFireAt: json['nextFireAt'] as String?,
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

  factory ThreadMessage.fromJson(Map<String, dynamic> json) {
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
    );
  }
}
