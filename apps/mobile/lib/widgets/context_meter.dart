import 'package:flutter/material.dart';

/// Compact, readable context usage signal for a chat header.
class ContextMeter extends StatelessWidget {
  const ContextMeter({
    super.key,
    required this.used,
    required this.limit,
  });

  final int used;
  final int limit;

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
    return Semantics(
      key: const Key('context-meter'),
      label: 'Context $used of $limit tokens',
      child: SizedBox(
        width: 92,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text('$used/$limit', style: Theme.of(context).textTheme.labelSmall),
            const SizedBox(height: 2),
            LinearProgressIndicator(
              key: const Key('context-meter-progress'),
              value: progress,
              color: color,
              backgroundColor: color.withValues(alpha: 0.18),
            ),
          ],
        ),
      ),
    );
  }
}
