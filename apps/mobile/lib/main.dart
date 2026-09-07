import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'push/firebase_push_port.dart';
import 'push/noop_push_port.dart';
import 'push/push_port.dart';
import 'screens/login_screen.dart';

/// TASK-144 (Mobile Wave 1a) — default control-api base URL. No CORS
/// constraint applies to a native client (mirrors the task Description);
/// overridable at build time via `--dart-define=CONTROL_API_BASE_URL=...`
/// for a device pointed at a different host.
///
/// `localhost` never resolves to anything useful on a physical device —
/// it means the device itself, not the machine running control-api — so a
/// real device build always fails to connect regardless of network
/// reachability. Defaults to the dev machine's own Tailscale address
/// instead: control-api binds `0.0.0.0` (services/control-api/src/index.ts),
/// so it's already reachable there once running, and every other client in
/// this project (clawsrv, OpenSandbox, the worker) already addresses peers
/// by their Tailscale IP, not `localhost`, for exactly this reason.
const String _defaultBaseUrl = String.fromEnvironment(
  'CONTROL_API_BASE_URL',
  defaultValue: 'http://100.67.177.24:3000',
);

/// TASK-149 (Mobile Wave 2b) — the push config gate. No
/// `google-services.json`/`GoogleService-Info.plist` exists yet (and none
/// may be committed — WORKFLOW_MOBILE_W1_W2_2026-09-04.md), so
/// `Firebase.initializeApp()` throws on every build today; that failure is
/// the gate itself, not an error to surface. When a real config file is
/// added later, this same code starts returning a working
/// [FirebasePushPort] with no further change needed here.
Future<PushPort> _resolvePushPort() async {
  try {
    await Firebase.initializeApp();
    return FirebasePushPort();
  } catch (_) {
    return const NoopPushPort();
  }
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final pushPort = await _resolvePushPort();
  runApp(
    OikonomosApp(
      apiClient: ApiClient(baseUrl: _defaultBaseUrl),
      pushPort: pushPort,
    ),
  );
}

class OikonomosApp extends StatelessWidget {
  const OikonomosApp({
    super.key,
    required this.apiClient,
    this.pushPort = const NoopPushPort(),
  });

  final ApiClient apiClient;
  final PushPort pushPort;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'OIKONOMOS',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: LoginScreen(apiClient: apiClient, pushPort: pushPort),
    );
  }
}
