/// Human-readable rendering of a routine's cron schedule, mirroring
/// `describeCron` in `services/worker/src/routineTool.ts` so the mobile
/// client shows the same wording the backend posts into the thread when a
/// routine is created ("Every day at 2:00 PM"). Anything the simple
/// minute/hour/weekday grammar cannot express falls back to the raw cron.
library;

const _weekdayNames = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

String describeSchedule(String? schedule) {
  if (schedule == null || schedule.trim().isEmpty) return 'Not scheduled';
  final parts = schedule.trim().split(RegExp(r'\s+'));
  if (parts.length != 5) return 'On schedule: $schedule';
  final minute = int.tryParse(parts[0]);
  final hour = int.tryParse(parts[1]);
  if (minute == null ||
      hour == null ||
      minute < 0 ||
      minute > 59 ||
      hour < 0 ||
      hour > 23 ||
      parts[2] != '*' ||
      parts[3] != '*') {
    return 'On schedule: $schedule';
  }
  final time = _formatHourMinute(hour, minute);
  if (parts[4] == '*') return 'Every day at $time';
  final weekday = int.tryParse(parts[4]);
  if (weekday != null && weekday >= 0 && weekday <= 6) {
    return 'Every ${_weekdayNames[weekday]} at $time';
  }
  return 'On schedule: $schedule';
}

String _formatHourMinute(int hour, int minute) {
  final suffix = hour >= 12 ? 'PM' : 'AM';
  final hour12 = hour % 12 == 0 ? 12 : hour % 12;
  final mm = minute.toString().padLeft(2, '0');
  return '$hour12:$mm $suffix';
}
