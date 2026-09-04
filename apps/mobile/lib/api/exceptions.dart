/// TASK-144 (Mobile Wave 1a) — exception types mirroring
/// `apps/dashboard/src/lib/api.ts`'s error surface: a 401 from any call
/// is a distinct, catchable [UnauthorizedError] so callers can route to
/// the login screen uniformly, everything else is a generic
/// [ApiException] carrying the server's `error` message when present.
library;

class UnauthorizedError implements Exception {
  const UnauthorizedError();

  @override
  String toString() => 'UnauthorizedError: unauthorized';
}

class ApiException implements Exception {
  const ApiException(this.message);

  final String message;

  @override
  String toString() => 'ApiException: $message';
}
