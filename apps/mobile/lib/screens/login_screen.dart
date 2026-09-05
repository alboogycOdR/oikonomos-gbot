import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../push/noop_push_port.dart';
import '../push/push_port.dart';
import 'roster_screen.dart';

/// TASK-173 — the Firebase project's **Web** OAuth client id
/// (`client_type: 3` in `apps/mobile/android/app/google-services.json`,
/// project `basileia-oikonomos-gmail`). This is `google_sign_in`'s
/// `serverClientId`, not a guess: per the current (v7) `google_sign_in`/
/// `firebase_auth` APIs, the ID token obtained from an interactive sign-in
/// is only exchangeable for a Firebase session — and therefore only
/// verifiable by `services/control-api/src/auth.ts`'s
/// `verifyFirebaseIdToken` against Google's real JWKS — when the sign-in
/// was initialized with the *server's* OAuth client id as the audience, not
/// the per-platform Android client id also present in that file.
const String _webOAuthClientId =
    '461377597606-hl2k4bvqdvpo2qu17v7vvrk532fo1sve.apps.googleusercontent.com';

/// Thrown by [GoogleAuthPort.signIn] when the user dismisses the Google
/// account picker without choosing an account — distinguished from every
/// other failure so the UI can show a milder message than a real error.
class SignInCancelledException implements Exception {
  const SignInCancelledException();

  @override
  String toString() => 'SignInCancelledException: sign-in cancelled';
}

/// Abstraction over the real Google Sign-In + Firebase Auth exchange, so
/// widget tests can substitute a fake instead of touching platform
/// channels the test harness has no access to — the same pattern
/// [PushPort]/[NoopPushPort] already use for push registration.
abstract class GoogleAuthPort {
  /// Runs the interactive Google account picker, then exchanges the
  /// resulting Google credential for a Firebase session, returning a real,
  /// backend-verifiable Firebase ID token. Throws
  /// [SignInCancelledException] on cancellation, or any other exception on
  /// a real failure (network, misconfiguration, backend-unrelated SDK
  /// error).
  Future<String> signIn();

  /// Signs out of both the Firebase session and the cached Google account,
  /// so the next [signIn] shows the account picker again rather than
  /// auto-relogging the same account in silently.
  Future<void> signOut();
}

/// Real implementation: `google_sign_in` drives the interactive account
/// picker and yields a Google ID token; `firebase_auth` exchanges that
/// Google credential for the actual Firebase session whose ID token
/// `services/control-api/src/app.ts`'s `POST /auth/google` verifies.
///
/// `google_sign_in: ^7.2.0`'s API (current stable as of this task —
/// verified against the package's own README/example, not assumed from an
/// older major version) replaced the old `signIn()` with a singleton
/// (`GoogleSignIn.instance`) that must be `initialize`d exactly once before
/// `authenticate()` is called, and moved cancellation detection from a
/// null return to a thrown `GoogleSignInException` carrying
/// `GoogleSignInExceptionCode.canceled`.
class FirebaseGoogleAuthPort implements GoogleAuthPort {
  FirebaseGoogleAuthPort({this.serverClientId = _webOAuthClientId});

  final String serverClientId;
  bool _initialized = false;

  Future<void> _ensureInitialized() async {
    if (_initialized) return;
    await GoogleSignIn.instance.initialize(serverClientId: serverClientId);
    _initialized = true;
  }

  @override
  Future<String> signIn() async {
    await _ensureInitialized();
    late final GoogleSignInAccount googleUser;
    try {
      googleUser = await GoogleSignIn.instance.authenticate();
    } on GoogleSignInException catch (error) {
      if (error.code == GoogleSignInExceptionCode.canceled) {
        throw const SignInCancelledException();
      }
      rethrow;
    }
    final googleAuth = googleUser.authentication;
    final idToken = googleAuth.idToken;
    if (idToken == null) {
      throw StateError('Google sign-in returned no ID token');
    }
    final credential = GoogleAuthProvider.credential(idToken: idToken);
    final userCredential =
        await FirebaseAuth.instance.signInWithCredential(credential);
    final firebaseIdToken = await userCredential.user?.getIdToken();
    if (firebaseIdToken == null) {
      throw StateError('Firebase sign-in succeeded without an ID token');
    }
    return firebaseIdToken;
  }

  @override
  Future<void> signOut() async {
    await FirebaseAuth.instance.signOut();
    // TASK-174 REWORK fix: `GoogleSignIn.instance` is a true singleton, so
    // any `FirebaseGoogleAuthPort` instance can safely ensure it's
    // initialized before operating on it — gating on *this* instance's own
    // `_initialized` history (as before) silently skipped the real
    // GoogleSignIn.instance.signOut() call whenever sign-out ran on a
    // freshly-constructed port that never itself called signIn() (e.g. the
    // one RosterScreen constructs), leaving the cached Google account
    // un-cleared and causing a silent auto-relogin on next sign-in.
    await _ensureInitialized();
    await GoogleSignIn.instance.signOut();
  }
}

/// TASK-144 (Mobile Wave 1a) originally mirrored
/// `apps/dashboard/src/pages/LoginPage.tsx`'s shared-token field. TASK-173
/// replaces that with real per-user Google Sign-In: tapping the button
/// opens the real Google account picker, exchanges the result for a real
/// Firebase ID token via [GoogleAuthPort], and POSTs it to the real
/// `/auth/google` route ([ApiClient.loginWithGoogle]). No token of any kind
/// is ever logged, and nothing is held beyond the widget's own in-flight
/// submission.
///
/// Known, separate, not-yet-scoped gap (named honestly rather than fixed
/// or ignored here): [ApiClient] keeps its session cookie in memory only
/// (`ApiClient._sessionCookie`, by its own doc comment) — signing in again
/// on every app process restart is expected today regardless of which
/// auth mechanism issued the session, and is unrelated to this task.
class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.apiClient,
    this.pushPort = const NoopPushPort(),
    GoogleAuthPort? authPort,
  }) : authPort = authPort ?? const _DefaultAuthPort();

  final ApiClient apiClient;

  /// TASK-149 (Mobile Wave 2b) — threaded through to [RosterScreen], the
  /// landing screen after login, which is where push registration begins
  /// (registration needs the session cookie [ApiClient.loginWithGoogle]
  /// just captured). Defaults to the dormant [NoopPushPort] so every prior
  /// test of this screen is unaffected.
  final PushPort pushPort;

  /// Real Google/Firebase sign-in port. Defaults to a lazily-constructed
  /// [FirebaseGoogleAuthPort]; tests inject a fake here instead of
  /// touching the real SDKs, exactly as they inject a [FakeHttpClient]
  /// into [ApiClient].
  final GoogleAuthPort authPort;

  /// Signs out of both the app session and the cached Google account.
  /// Exposed as a static entry point rather than a widget of its own: no
  /// settings/roster surface exists in this task's `Owned_Paths` to host a
  /// visible button, so wiring one in is a real, flagged follow-up (see
  /// this task's dossier) rather than an out-of-territory edit to
  /// `roster_screen.dart`. The action itself is real and independently
  /// tested — it is only its UI placement that is deferred.
  static Future<void> signOut(
    ApiClient apiClient,
    GoogleAuthPort authPort,
  ) async {
    apiClient.clearSession();
    await authPort.signOut();
  }

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

/// Indirection so the `const` default in [LoginScreen]'s initializer list
/// never eagerly constructs a real [FirebaseGoogleAuthPort] (which is not
/// itself `const`-constructible) — the real port is created once, lazily,
/// the first time [_LoginScreenState] actually needs one.
class _DefaultAuthPort implements GoogleAuthPort {
  const _DefaultAuthPort();

  static FirebaseGoogleAuthPort? _shared;

  FirebaseGoogleAuthPort get _real => _shared ??= FirebaseGoogleAuthPort();

  @override
  Future<String> signIn() => _real.signIn();

  @override
  Future<void> signOut() => _real.signOut();
}

class _LoginScreenState extends State<LoginScreen> {
  String? _error;
  bool _submitting = false;

  Future<void> _submit() async {
    if (_submitting) return;
    setState(() {
      _error = null;
      _submitting = true;
    });
    try {
      final idToken = await widget.authPort.signIn();
      await widget.apiClient.loginWithGoogle(idToken);
      if (!mounted) return;
      await Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => RosterScreen(
            apiClient: widget.apiClient,
            pushPort: widget.pushPort,
            // TASK-174 REWORK defense-in-depth: reuse the same, already
            // `_ensureInitialized()`-warmed auth port instance this screen
            // just signed in with, instead of relying solely on the
            // singleton-safety fix in `FirebaseGoogleAuthPort.signOut()`
            // above to cover a fresh instance.
            authPort: widget.authPort,
          ),
        ),
      );
    } on SignInCancelledException {
      if (!mounted) return;
      setState(() => _error = null);
    } on UnauthorizedError {
      if (!mounted) return;
      setState(() => _error = 'Google sign-in was rejected by the server.');
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } catch (error) {
      if (!mounted) return;
      // Diagnostic detail included deliberately: this catch-all fires for
      // real SDK/platform failures (GoogleSignInException, PlatformException,
      // etc.) that carry no secrets, and a bare "please try again" gives a
      // real device failure no way to be diagnosed remotely.
      final detail = error.toString();
      setState(() => _error =
          'Sign-in failed: ${detail.length > 200 ? detail.substring(0, 200) : detail}');
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
            ElevatedButton(
              key: const Key('sign-in-button'),
              onPressed: _submitting ? null : _submit,
              child: Text(_submitting ? 'Signing in…' : 'Sign in with Google'),
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
