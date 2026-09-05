import 'package:flutter_test/flutter_test.dart';
import 'package:oikonomos_mobile/charter/charter_template.dart';

void main() {
  test('charter has all six prose headings', () {
    expect(botCharterTemplate, contains('# Job (and what I refuse)'));
    expect(botCharterTemplate, contains('# Connections'));
    expect(botCharterTemplate, contains('# Routines'));
    expect(botCharterTemplate, contains('# Skills'));
    expect(botCharterTemplate, contains('# Handoffs'));
    expect(botCharterTemplate, contains('# Check with me before…'));
  });

  test('charter contains no secrets, URLs, or account names', () {
    expect(botCharterTemplate, isNot(contains('://')));
    expect(botCharterTemplate, isNot(contains('api_key')));
    expect(botCharterTemplate, isNot(contains('password')));
    expect(botCharterTemplate, isNot(contains('@')));
  });
}
