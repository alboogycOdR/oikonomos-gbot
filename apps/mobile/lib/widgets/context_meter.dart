import 'package:flutter/material.dart';

/// Compact, readable context usage signal.
///
/// Was originally squeezed into the chat AppBar's title row alongside the
/// bot's avatar and name; on a real phone width that left too little room
/// for the name itself (it collapsed to an ellipsis). Moved to the bot
/// settings screen instead, where [expanded] renders it full-width with a
/// label rather than the original fixed-92dp compact form a cramped header
/// needed.
class ContextMeter extends StatelessWidget {
  const ContextMeter({
    super.key,
    required this.used,
    required this.limit,
    this.expanded = false,
  });

  final int used;
  final int limit;

  /// True for the settings-screen placement: full width, with a label, a
  /// larger progress bar, and normal (not `labelSmall`) text. False (the
  /// original compact form) is unused today but kept as the default so
  /// this widget's existing behaviour/tests are unaffected.
  final bool expanded;

  Color _color(BuildContext context) {
    final ratio = limit <= 0 ? 0.0 : used / limit;
    if (ratio >= 0.8) return Theme.of(context).colorScheme.error;
    if (ratio >= 0.6) return Colors.orange;
    return Theme.of(context).colorScheme.primary;
  }

  @override
  Widget build(BuildContext context) {
    final progress = limit <= 0 ? 0.0 : (used / limit).clamp(0.0, 1.0);
    final color = _color(context);
    final bar = LinearProgressIndicator(
      key: const Key('context-meter-progress'),
      value: progress,
      color: color,
      backgroundColor: color.withValues(alpha: 0.18),
      minHeight: expanded ? 8 : null,
    );

    final child = expanded
        ? Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('Context usage', style: Theme.of(context).textTheme.titleMedium),
                  Text('$used/$limit tokens', style: Theme.of(context).textTheme.bodyMedium),
                ],
              ),
              const SizedBox(height: 8),
              ClipRRect(borderRadius: BorderRadius.circular(4), child: bar),
            ],
          )
        : SizedBox(
            width: 92,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text('$used/$limit', style: Theme.of(context).textTheme.labelSmall),
                const SizedBox(height: 2),
                bar,
              ],
            ),
          );

    return Semantics(
      key: const Key('context-meter'),
      label: 'Context $used of $limit tokens',
      child: child,
    );
  }
}
