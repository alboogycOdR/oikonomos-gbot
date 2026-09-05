import 'package:oikonomos_mobile/attach/file_picker_port.dart';

class FakeFilePicker implements FilePickerPort {
  FakeFilePicker({this.picked});

  PickedAttachment? picked;
  int pickCount = 0;

  @override
  Future<PickedAttachment?> pick() async {
    pickCount += 1;
    return picked;
  }
}
