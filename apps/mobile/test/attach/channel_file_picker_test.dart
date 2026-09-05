import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/attach/channel_file_picker.dart';

void main() {
  test('maps known extensions onto the server allow-list', () {
    expect(contentTypeForFilename('photo.JPG'), 'image/jpeg');
    expect(contentTypeForFilename('a.png'), 'image/png');
    expect(contentTypeForFilename('notes.md'), 'text/markdown');
    expect(contentTypeForFilename('data.json'), 'application/json');
    expect(contentTypeForFilename('doc.pdf'), 'application/pdf');
    expect(contentTypeForFilename('plain.txt'), 'text/plain');
  });

  test('unknown extensions are octet-stream so the server rejects them', () {
    expect(contentTypeForFilename('payload.exe'), 'application/octet-stream');
    expect(contentTypeForFilename('no-extension'), 'application/octet-stream');
  });
}
