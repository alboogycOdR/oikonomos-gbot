import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'screens/login_screen.dart';

/// TASK-144 (Mobile Wave 1a) — default control-api base URL for local
/// development. No CORS constraint applies to a native client (mirrors
/// the task Description); overridable at build time via
/// `--dart-define=CONTROL_API_BASE_URL=...` for a device pointed at a
/// non-default host.
const String _defaultBaseUrl = String.fromEnvironment(
  'CONTROL_API_BASE_URL',
  defaultValue: 'http://localhost:3000',
);

void main() {
  runApp(OikonomosApp(apiClient: ApiClient(baseUrl: _defaultBaseUrl)));
}

class OikonomosApp extends StatelessWidget {
  const OikonomosApp({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'OIKONOMOS',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: LoginScreen(apiClient: apiClient),
    );
  }
}
