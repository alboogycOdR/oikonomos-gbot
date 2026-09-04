import 'package:flutter/material.dart';

import '../api/api_client.dart';

/// TASK-144 (Mobile Wave 1a) — placeholder landing screen reached after a
/// successful login. Thread list / chat UI is out of this task's scope
/// (later Mobile Wave work); this exists only so the login screen has a
/// real navigation target to prove the success path end-to-end.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('OIKONOMOS')),
      body: const Center(child: Text('Signed in.')),
    );
  }
}
