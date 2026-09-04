/// TASK-149 (Mobile Wave 2b) — the two backend push triggers
/// (`services/control-api/src/ports.ts`'s `notifyAfterChatRun`), decoded
/// from the FCM data-only payload (`{ type, runId }`, never a `notification`
/// block — see `services/control-api/src/pushTransport.ts`'s
/// `FcmHttpPushTransport.send`). Data-only messages always reach
/// [PushPort.onForegroundMessage] while the app is foregrounded, regardless
/// of OS notification permission state.
enum PushMessageType {
  approvalPending,
  runCompleted;

  static PushMessageType? fromWire(String? value) {
    switch (value) {
      case 'approval-pending':
        return PushMessageType.approvalPending;
      case 'run-completed':
        return PushMessageType.runCompleted;
      default:
        return null;
    }
  }
}

class PushMessage {
  const PushMessage({required this.type, required this.runId});

  final PushMessageType type;
  final String runId;

  /// Parses the raw FCM `data` map. Returns `null` for a payload missing
  /// either field or carrying an unrecognized `type` — a forward-compatible
  /// server-side addition is silently ignored rather than crashing the
  /// foreground handler.
  static PushMessage? fromData(Map<String, dynamic> data) {
    final type = PushMessageType.fromWire(data['type'] as String?);
    final runId = data['runId'] as String?;
    if (type == null || runId == null || runId.isEmpty) return null;
    return PushMessage(type: type, runId: runId);
  }

  String get displayText {
    switch (type) {
      case PushMessageType.approvalPending:
        return 'A new approval is waiting for you.';
      case PushMessageType.runCompleted:
        return 'A run just completed.';
    }
  }
}
