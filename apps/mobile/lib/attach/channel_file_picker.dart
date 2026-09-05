import 'package:file_picker/file_picker.dart';

import 'file_picker_port.dart';

/// Production picker: the platform document/photo sheet (`file_picker`).
class ChannelFilePicker implements FilePickerPort {
  const ChannelFilePicker();

  @override
  Future<PickedAttachment?> pick() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: const [
        'jpg',
        'jpeg',
        'png',
        'gif',
        'webp',
        'txt',
        'text',
        'md',
        'markdown',
        'csv',
        'json',
        'pdf',
      ],
      withData: true,
    );
    if (result == null || result.files.isEmpty) return null;
    final file = result.files.first;
    final bytes = file.bytes;
    if (bytes == null || bytes.isEmpty) return null;
    return PickedAttachment(
      filename: file.name,
      contentType: contentTypeForFilename(file.name),
      bytes: bytes,
    );
  }
}

/// Maps a filename to the content types the control-api allow-list accepts.
/// Unknown extensions are `application/octet-stream` so the server rejects
/// them instead of the client silently relabelling a binary as text/plain.
String contentTypeForFilename(String filename) {
  final dot = filename.lastIndexOf('.');
  final ext = dot <= 0 ? '' : filename.substring(dot + 1).toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'csv':
      return 'text/csv';
    case 'json':
      return 'application/json';
    case 'pdf':
      return 'application/pdf';
    case 'txt':
    case 'text':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}
