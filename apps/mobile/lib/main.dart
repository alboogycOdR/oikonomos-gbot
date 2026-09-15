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
/// reachability. This originally defaulted to the dev machine's raw
/// Tailscale IP + control-api's own port (`http://100.67.177.24:3000`),
/// reasoning that control-api binds `0.0.0.0` and is therefore reachable
/// there directly. TASK-263 found that assumption false against a real
/// device: TASK-240's release runbook established `https://studyworkstation.
/// <tailnet>.ts.net` (Tailscale Serve, port 443, tailnet-only) as the one
/// supported client-facing origin, and a real phone hitting the raw
/// `:3000` address directly gets a connection abort — nothing about the
/// port-3000 path was ever actually exercised end-to-end before. Point at
/// the same HTTPS origin the dashboard already uses.
const String _defaultBaseUrl = String.fromEnvironment(
  'CONTROL_API_BASE_URL',
  defaultValue: 'https://studyworkstation.tailbb9d39.ts.net',
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
