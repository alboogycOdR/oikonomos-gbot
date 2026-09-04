import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import 'home_screen.dart';

/// TASK-144 (Mobile Wave 1a) — mirrors
/// `apps/dashboard/src/pages/LoginPage.tsx`'s shape: a single shared
/// access-token field, an error on a bad token, and a landing screen on
/// success. The raw token typed into [_tokenController] lives only in
/// widget state for the duration of the form submission — it is never
/// logged and is cleared immediately after the login call resolves either
/// way, so it cannot linger in memory or be surfaced by a later screenshot
/// / state dump.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _tokenController = TextEditingController();
  String? _error;
  bool _submitting = false;
  bool _hasToken = false;

  @override
  void initState() {
    super.initState();
    _tokenController.addListener(_handleTokenChanged);
  }

  void _handleTokenChanged() {
    final hasToken = _tokenController.text.isNotEmpty;
    if (hasToken != _hasToken) {
      setState(() => _hasToken = hasToken);
    }
  }

  @override
  void dispose() {
    _tokenController.removeListener(_handleTokenChanged);
    _tokenController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final token = _tokenController.text;
    if (token.isEmpty || _submitting) return;
    setState(() {
      _error = null;
      _submitting = true;
    });
    try {
      await widget.apiClient.login(token);
      _tokenController.clear();
      if (!mounted) return;
      await Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => HomeScreen(apiClient: widget.apiClient),
        ),
      );
    } on UnauthorizedError {
      _tokenController.clear();
      if (!mounted) return;
      setState(() => _error = 'Invalid token.');
    } catch (_) {
      _tokenController.clear();
      if (!mounted) return;
      setState(() => _error = 'Invalid token.');
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('OIKONOMOS')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Access token'),
            const SizedBox(height: 8),
            TextField(
              key: const Key('token-field'),
              controller: _tokenController,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              onSubmitted: (_) => _submit(),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              key: const Key('sign-in-button'),
              onPressed: (_submitting || !_hasToken) ? null : _submit,
              child: const Text('Sign in'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(
                _error!,
                key: const Key('login-error'),
                style: const TextStyle(color: Colors.red),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
