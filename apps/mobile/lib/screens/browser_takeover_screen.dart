import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/browser_takeover_client.dart';

/// TASK-235 (G-07 part 2b) — the browser-flavoured counterpart to
/// [TakeoverScreen] (TASK-228, shell/PTY): a genuinely interactive view of
/// a real, live browser page (a CAPTCHA, a login wall, a payment step)
/// via [BrowserTakeoverClient]. Unlike the shell case, there is no
/// terminal transcript — the live screencast IS the transcript, one JPEG
/// frame at a time, and input is a real tap/keystroke on the page itself
/// rather than typed lines.
///
/// Same three-plus-one state convention as [TakeoverScreen]: loading,
/// live (the real screencast + input surface), error. There is
/// deliberately no "empty" state here the way [TakeoverScreen] has one —
/// this screen is only ever opened from [TakeoverCard]'s `onTakeOver`,
/// which already confirmed a pending browser-kind takeover exists; a
/// stale/already-handed-back run surfaces through the WS connection
/// itself refusing (handled as [_TakeoverViewState.error], same as any
/// other transport failure — the server route's own 404/409 refusal and
/// a closed socket look identical from here, and both mean "nothing to
/// show").
class BrowserTakeoverScreen extends StatefulWidget {
  const BrowserTakeoverScreen({
    super.key,
    required this.apiClient,
    required this.runId,
    BrowserTakeoverClient? client,
  }) : _client = client;

  final ApiClient apiClient;
  final String runId;
  final BrowserTakeoverClient? _client;

  @override
  State<BrowserTakeoverScreen> createState() => _BrowserTakeoverScreenState();
}

enum _TakeoverViewState { loading, live, error }

class _BrowserTakeoverScreenState extends State<BrowserTakeoverScreen> {
  late final BrowserTakeoverClient _client =
      widget._client ?? BrowserTakeoverClient(apiClient: widget.apiClient);
  final TextEditingController _typeController = TextEditingController();

  _TakeoverViewState _state = _TakeoverViewState.loading;
  String? _errorMessage;
  Uint8List? _latestFrame;
  BrowserTakeoverSubscription? _subscription;

  @override
  void initState() {
    super.initState();
    _subscription = _client.takeover(
      runId: widget.runId,
      onFrame: _showFrame,
      onDone: () {
        // The Steel session or the take-over connection itself ended
        // (including a normal, intentional hand-back) — leave the last
        // frame visible rather than replacing it with an error; the
        // hosting screen's own `onDone` (POST .../takeover/complete) is
        // what actually records the hand-back.
      },
      onError: (error) {
        if (!mounted) return;
        setState(() {
          _state = _TakeoverViewState.error;
          _errorMessage = error.toString();
        });
      },
    );
  }

  void _showFrame(List<int> jpegBytes) {
    if (!mounted) return;
    setState(() {
      _state = _TakeoverViewState.live;
      _latestFrame = Uint8List.fromList(jpegBytes);
    });
  }

  void _handleTapUp(TapUpDetails details, BoxConstraints constraints) {
    // The screencast image is displayed at whatever size the box lays it
    // out at; CDP page coordinates are the image's own native pixels.
    // Since `Page.startScreencast` is left at its default (no explicit
    // max width/height clamp), the rendered box and the page's own
    // viewport are the same size in practice for this fixed-aspect view,
    // so the local tap position is used directly as the CDP coordinate.
    _subscription?.tap(details.localPosition.dx, details.localPosition.dy);
  }

  void _sendTypedText() {
    final text = _typeController.text;
    if (text.isEmpty) return;
    _subscription?.typeText(text);
    _typeController.clear();
  }

  @override
  void dispose() {
    _subscription?.close();
    _typeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Take over — browser')),
      body: switch (_state) {
        _TakeoverViewState.loading => const Center(
            key: Key('browser-takeover-loading'),
            child: CircularProgressIndicator(),
          ),
        _TakeoverViewState.error => Center(
            key: const Key('browser-takeover-error'),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                _errorMessage ?? 'Could not load the live browser view.',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
          ),
        _TakeoverViewState.live => Column(
            children: [
              Expanded(
                child: LayoutBuilder(
                  builder: (context, constraints) => GestureDetector(
                    key: const Key('browser-takeover-surface'),
                    onTapUp: (details) => _handleTapUp(details, constraints),
                    child: Container(
                      color: Colors.black,
                      width: double.infinity,
                      child: _latestFrame == null
                          ? const SizedBox.shrink()
                          : Image.memory(
                              _latestFrame!,
                              key: const Key('browser-takeover-frame'),
                              gaplessPlayback: true,
                              fit: BoxFit.contain,
                            ),
                    ),
                  ),
                ),
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          key: const Key('browser-takeover-input'),
                          controller: _typeController,
                          decoration: const InputDecoration(
                            hintText: 'Type here — password, code, etc.',
                            isDense: true,
                            border: OutlineInputBorder(),
                          ),
                          onSubmitted: (_) => _sendTypedText(),
                        ),
                      ),
                      IconButton(
                        key: const Key('browser-takeover-send'),
                        icon: const Icon(Icons.send),
                        onPressed: _sendTypedText,
                      ),
                      IconButton(
                        key: const Key('browser-takeover-enter'),
                        icon: const Icon(Icons.keyboard_return),
                        tooltip: 'Enter',
                        onPressed: () => _subscription?.dispatchKey('Enter'),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
      },
    );
  }
}
