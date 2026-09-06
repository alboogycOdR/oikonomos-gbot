import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/widgets/context_meter.dart';

void main() {
  testWidgets(
      'renders usage and changes color at the 60 and 80 percent thresholds',
      (tester) async {
    Future<Color?> colorFor(int used) async {
      await tester.pumpWidget(MaterialApp(
          home: Scaffold(body: ContextMeter(used: used, limit: 100))));
      return tester
          .widget<LinearProgressIndicator>(
              find.byKey(const Key('context-meter-progress')))
          .color;
    }

    final low = await colorFor(59);
    final warning = await colorFor(60);
    final critical = await colorFor(80);
    expect(low, isNot(warning));
    expect(warning, isNot(critical));
    expect(find.text('80/100'), findsOneWidget);
  });
}
