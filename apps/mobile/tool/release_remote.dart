import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

/// TASK-152 — release delivery: upload a built APK to Gofile (anonymous,
/// ~10-day expiry, no auth, no size cap) and post the resulting download
/// link to a Telegram chat via the Bot API.
///
/// Three calls, strictly in this order:
///   1. `GET  https://api.gofile.io/servers`            — pick `data.servers[0].name`
///   2. `POST https://<server>.gofile.io/contents/uploadfile` — multipart, field `file`
///   3. `POST https://api.telegram.org/bot<TOKEN>/sendMessage` — plain text, no `parse_mode`
///
/// `sendMessage` deliberately omits `parse_mode`: Telegram's legacy Markdown
/// parser aborts the whole send on any unmatched `_`/`*`/backtick in a commit
/// message, and MarkdownV2 requires escaping ~15 characters. Plain text is
/// reliable and Telegram auto-links URLs regardless.
///
/// `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are read from the process
/// environment only — never hardcoded, never defaulted, never logged in
/// full (a bot token is a credential like any other; CLAUDE.md
/// non-negotiable 4 applies).
///
/// Deliberately does NOT shell out to `git` for a commit hash/message: this
/// repo's git history and this app's own version are two different things,
/// and reading the invoking shell's git state from inside a release script
/// is an implicit dependency that breaks under CI or a different working
/// directory. Pass `--note` instead.
class MissingEnvVarError implements Exception {
  MissingEnvVarError(this.varName);

  final String varName;

  @override
  String toString() =>
      'MissingEnvVarError: required environment variable "$varName" is not set';
}

class MissingFileError implements Exception {
  MissingFileError(this.path);

  final String path;

  @override
  String toString() => 'MissingFileError: release file not found at "$path"';
}

/// Raised when a remote call succeeds at the HTTP layer but the response
/// body signals failure (non-2xx status, or an API-level error field).
class ReleaseCallError implements Exception {
  ReleaseCallError(this.message);

  final String message;

  @override
  String toString() => 'ReleaseCallError: $message';
}

const String defaultApkPath = 'build/app/outputs/flutter-apk/app-release.apk';

/// Reads the required Telegram credentials from [environment], throwing
/// [MissingEnvVarError] naming the first missing variable. Checked
/// independently so each is reported precisely, never a generic failure.
class TelegramCredentials {
  TelegramCredentials({required this.botToken, required this.chatId});

  final String botToken;
  final String chatId;

  factory TelegramCredentials.fromEnvironment(Map<String, String> environment) {
    final token = environment['TELEGRAM_BOT_TOKEN'];
    if (token == null || token.isEmpty) {
      throw MissingEnvVarError('TELEGRAM_BOT_TOKEN');
    }
    final chatId = environment['TELEGRAM_CHAT_ID'];
    if (chatId == null || chatId.isEmpty) {
      throw MissingEnvVarError('TELEGRAM_CHAT_ID');
    }
    return TelegramCredentials(botToken: token, chatId: chatId);
  }
}

/// Performs the three-call release flow. The [http.Client] is injectable
/// so tests can substitute a fake — no real network call is ever made in
/// the test suite.
class ReleasePublisher {
  ReleasePublisher({http.Client? httpClient}) : _client = httpClient ?? http.Client();

  final http.Client _client;

  /// Step 1: fetch the Gofile server list and return the first server's
  /// `name` (e.g. `"store1"`), to be used as the upload subdomain.
  Future<String> fetchUploadServer() async {
    final response = await _client.get(Uri.parse('https://api.gofile.io/servers'));
    if (response.statusCode != 200) {
      throw ReleaseCallError(
        'Gofile /servers returned HTTP ${response.statusCode}: ${response.body}',
      );
    }
    final Map<String, dynamic> decoded = _decodeJsonObject(response.body, 'Gofile /servers');
    final data = decoded['data'];
    if (data is! Map<String, dynamic>) {
      throw ReleaseCallError('Gofile /servers response missing "data" object');
    }
    final servers = data['servers'];
    if (servers is! List || servers.isEmpty) {
      throw ReleaseCallError('Gofile /servers response has no servers');
    }
    final first = servers.first;
    if (first is! Map<String, dynamic> || first['name'] is! String) {
      throw ReleaseCallError('Gofile /servers first entry has no "name"');
    }
    return first['name'] as String;
  }

  /// Step 2: multipart-upload [file] to `server`, returning the public
  /// `downloadPage` URL.
  Future<String> uploadFile(String server, File file) async {
    final uri = Uri.parse('https://$server.gofile.io/contents/uploadfile');
    final request = http.MultipartRequest('POST', uri)
      ..files.add(await http.MultipartFile.fromPath('file', file.path));
    final streamedResponse = await _client.send(request);
    final response = await http.Response.fromStream(streamedResponse);
    if (response.statusCode != 200) {
      throw ReleaseCallError(
        'Gofile upload returned HTTP ${response.statusCode}: ${response.body}',
      );
    }
    final Map<String, dynamic> decoded = _decodeJsonObject(response.body, 'Gofile upload');
    final data = decoded['data'];
    if (data is! Map<String, dynamic> || data['downloadPage'] is! String) {
      throw ReleaseCallError('Gofile upload response missing "data.downloadPage"');
    }
    return data['downloadPage'] as String;
  }

  /// Step 3: post a plain-text message to the Telegram chat. Deliberately
  /// never sends a `parse_mode` field.
  Future<void> sendTelegramMessage({
    required TelegramCredentials credentials,
    required String text,
  }) async {
    final uri = Uri.parse(
      'https://api.telegram.org/bot${credentials.botToken}/sendMessage',
    );
    final body = <String, String>{
      'chat_id': credentials.chatId,
      'text': text,
    };
    final response = await _client.post(
      uri,
      headers: {'content-type': 'application/json'},
      body: jsonEncode(body),
    );
    if (response.statusCode != 200) {
      throw ReleaseCallError(
        'Telegram sendMessage returned HTTP ${response.statusCode}: ${response.body}',
      );
    }
    final Map<String, dynamic> decoded = _decodeJsonObject(response.body, 'Telegram sendMessage');
    if (decoded['ok'] != true) {
      throw ReleaseCallError('Telegram sendMessage response reported ok=false: ${response.body}');
    }
  }

  Map<String, dynamic> _decodeJsonObject(String body, String context) {
    final Object? decoded;
    try {
      decoded = jsonDecode(body);
    } on FormatException {
      throw ReleaseCallError('$context returned a non-JSON body: $body');
    }
    if (decoded is! Map<String, dynamic>) {
      throw ReleaseCallError('$context returned a non-object JSON body: $body');
    }
    return decoded;
  }
}

/// Builds the release announcement text: filename, size in MB, an expiry
/// note, the download link, and an optional caller-supplied [note] — never
/// derived from git state.
String buildReleaseMessage({
  required String fileName,
  required double sizeMb,
  required String downloadPage,
  String? note,
}) {
  final sizeText = sizeMb.toStringAsFixed(2);
  final buffer = StringBuffer()
    ..writeln('New build: $fileName')
    ..writeln('Size: $sizeText MB')
    ..writeln('Link: $downloadPage')
    ..writeln('Expires in ~10 days (Gofile anonymous upload)');
  if (note != null && note.isNotEmpty) {
    buffer.writeln(note);
  }
  return buffer.toString().trimRight();
}

/// Validates [filePath] exists, throwing [MissingFileError] before any
/// network call is attempted.
File requireExistingFile(String filePath) {
  final file = File(filePath);
  if (!file.existsSync()) {
    throw MissingFileError(filePath);
  }
  return file;
}

/// End-to-end orchestration used by both `main` and tests: validates
/// inputs, then runs the three-call flow in order.
Future<void> publishRelease({
  required String filePath,
  String? note,
  required Map<String, String> environment,
  required ReleasePublisher publisher,
}) async {
  final file = requireExistingFile(filePath);
  final credentials = TelegramCredentials.fromEnvironment(environment);

  final server = await publisher.fetchUploadServer();
  final downloadPage = await publisher.uploadFile(server, file);

  final sizeMb = file.lengthSync() / (1024 * 1024);
  final fileName = file.uri.pathSegments.isNotEmpty ? file.uri.pathSegments.last : filePath;
  final message = buildReleaseMessage(
    fileName: fileName,
    sizeMb: sizeMb,
    downloadPage: downloadPage,
    note: note,
  );

  await publisher.sendTelegramMessage(credentials: credentials, text: message);
}

/// Parses `--note <value>` (or `--note=value`) out of [args], returning the
/// note and the remaining positional arguments.
({String? note, List<String> positional}) parseArgs(List<String> args) {
  String? note;
  final positional = <String>[];
  for (var i = 0; i < args.length; i++) {
    final arg = args[i];
    if (arg == '--note') {
      if (i + 1 >= args.length) {
        throw ArgumentError('--note requires a value');
      }
      note = args[++i];
    } else if (arg.startsWith('--note=')) {
      note = arg.substring('--note='.length);
    } else {
      positional.add(arg);
    }
  }
  return (note: note, positional: positional);
}

Future<void> main(List<String> args) async {
  final parsed = parseArgs(args);
  final filePath = parsed.positional.isNotEmpty ? parsed.positional.first : defaultApkPath;

  try {
    await publishRelease(
      filePath: filePath,
      note: parsed.note,
      environment: Platform.environment,
      publisher: ReleasePublisher(),
    );
    stdout.writeln('Release published: $filePath');
  } on MissingEnvVarError catch (e) {
    stderr.writeln(e);
    exitCode = 1;
  } on MissingFileError catch (e) {
    stderr.writeln(e);
    exitCode = 1;
  } on ReleaseCallError catch (e) {
    stderr.writeln(e);
    exitCode = 1;
  }
}
