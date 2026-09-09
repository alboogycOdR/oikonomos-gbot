import 'package:flutter/material.dart';

/// TASK-188 (G-07) — the human half of TASK-204/225's
/// `human_takeover_required` event/park contract: an inline card asking the
/// human to take over (sign in, solve a CAPTCHA, complete 2FA/payment) and,
/// once done, hand the run back.
///
/// Deliberately a pure, typed-callback widget — same separation
/// [SecretRequestCard] already established: this file owns rendering only,
/// not the API call or navigation. [onTakeOver] is the hosting screen's own
/// decision what "take over" means (today: opens the existing read-only
/// live view — see this widget's own doc note on the honest gap that
/// remains there); [onDone] is the hosting screen's call to
/// `POST /runs/:id/takeover/complete`.
///
/// HONEST GAP, not hidden: as of TASK-188, [onTakeOver] cannot yet open a
/// genuinely INTERACTIVE view — `LiveAgentScreen`/`LiveAgentClient` only
/// implement execd's read-only `mode=viewer` stream (TASK-171). Real
/// interactive control needs execd's own `mode` default (holder, exclusive,
/// write-capable) plus its `takeover=1` eviction query param — confirmed by
/// reading execd's own upstream source (`pty_ws.go`), not guessed — AND a
/// production `LiveAgentPort`/`TakeoverPort` implementation, neither of
/// which is wired yet (both are deliberately deferred follow-up work, same
/// shape as `LiveAgentPort` itself already documents). This card is
/// correct and ready for that hand-off the moment it lands; it does not
/// pretend the wiring already exists.
class TakeoverCard extends StatelessWidget {
  const TakeoverCard({
    super.key,
    required this.runId,
    required this.kind,
    required this.detail,
    required this.status,
    required this.busy,
    required this.onTakeOver,
    required this.onDone,
  });

  final String runId;

  /// One of `captcha` / `two_factor` / `login_wall` / `payment` — the same
  /// vocabulary `detectHumanTakeover` (packages/connectors) and
  /// `HUMAN_TAKEOVER_REQUIRED_EVENT_TYPE`'s payload already use.
  final String kind;
  final String detail;

  /// `'pending'` shows the Take over / Done actions. Any other value
  /// (e.g. `'Completed'`, an error message) collapses the card to a single
  /// status line, matching [SecretRequestCard]'s own convention.
  final String status;
  final bool busy;
  final VoidCallback onTakeOver;
  final Future<void> Function() onDone;

  String get _kindLabel => switch (kind) {
        'captcha' => 'Solve a CAPTCHA',
        'two_factor' => 'Complete two-factor authentication',
        'login_wall' => 'Sign in',
        'payment' => 'Confirm a payment',
        _ => 'Take a manual step',
      };

  @override
  Widget build(BuildContext context) {
    final pending = status == 'pending';
    return Card(
      key: Key('takeover-card-$runId'),
      color: Theme.of(context).colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Needs you: $_kindLabel',
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            Text(detail),
            const SizedBox(height: 8),
            if (pending) ...[
              Row(
                children: [
                  ElevatedButton(
                    key: const Key('takeover-take-over'),
                    onPressed: busy ? null : onTakeOver,
                    child: const Text('Take over'),
                  ),
                  const SizedBox(width: 8),
                  TextButton(
                    key: const Key('takeover-done'),
                    onPressed: busy ? null : onDone,
                    child: const Text('Done'),
                  ),
                ],
              ),
            ] else
              Text(
                status,
                key: Key('takeover-status-$runId'),
              ),
          ],
        ),
      ),
    );
  }
}
