import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/util/schedule.dart';

void main() {
  test('null or blank schedule reads as not scheduled', () {
    expect(describeSchedule(null), 'Not scheduled');
    expect(describeSchedule('   '), 'Not scheduled');
  });

  test('daily cron reads as a time of day', () {
    expect(describeSchedule('0 8 * * *'), 'Every day at 8:00 AM');
    expect(describeSchedule('30 14 * * *'), 'Every day at 2:30 PM');
    expect(describeSchedule('0 0 * * *'), 'Every day at 12:00 AM');
    expect(describeSchedule('5 12 * * *'), 'Every day at 12:05 PM');
  });

  test('weekday cron names the day', () {
    expect(describeSchedule('0 9 * * 1'), 'Every Monday at 9:00 AM');
    expect(describeSchedule('15 17 * * 0'), 'Every Sunday at 5:15 PM');
  });

  test('anything else falls back to the raw cron', () {
    expect(describeSchedule('*/5 * * * *'), 'On schedule: */5 * * * *');
    expect(describeSchedule('0 8 1 * *'), 'On schedule: 0 8 1 * *');
    expect(describeSchedule('0 8 * * 7'), 'On schedule: 0 8 * * 7');
    expect(describeSchedule('0 25 * * *'), 'On schedule: 0 25 * * *');
    expect(describeSchedule('not a cron'), 'On schedule: not a cron');
  });
}
