/// TASK-166 — file/image picker seam so ChatScreen can be widget-tested
/// against a fake without opening a platform document picker.
library;

class PickedAttachment {
  const PickedAttachment({
    required this.filename,
    required this.contentType,
    required this.bytes,
  });

  final String filename;
  final String contentType;
  final List<int> bytes;
}

abstract class FilePickerPort {
  /// Opens a real (or fake) file/image picker. Returns null when the user
  /// cancels. Never logs file bytes.
  Future<PickedAttachment?> pick();
}
