import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';

/// Per-bot Require-Approval rules. The API validates that a chosen
/// capability is actually granted to this role; the selector prevents the
/// common client-side mistake before that validation is needed.
class ReviewRulesScreen extends StatefulWidget {
  const ReviewRulesScreen({
    super.key,
    required this.apiClient,
    required this.roleId,
  });

  final ApiClient apiClient;
  final String roleId;

  @override
  State<ReviewRulesScreen> createState() => _ReviewRulesScreenState();
}

class _ReviewRulesScreenState extends State<ReviewRulesScreen> {
  List<ReviewRule>? _rules;
  List<RoleGrant>? _grants;
  String? _error;
  String? _selectedCapability;
  bool _adding = false;
  final Set<String> _removing = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await Future.wait([
        widget.apiClient.listReviewRules(widget.roleId),
        widget.apiClient.listRoleGrants(widget.roleId),
      ]);
      if (!mounted) return;
      setState(() {
        _rules = result[0] as List<ReviewRule>;
        _grants = result[1] as List<RoleGrant>;
        _error = null;
      });
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load review rules.');
    }
  }

  Future<void> _add() async {
    final capabilityId = _selectedCapability;
    if (capabilityId == null || _adding) return;
    setState(() => _adding = true);
    try {
      final rule = await widget.apiClient.createReviewRule(
        widget.roleId,
        capabilityId,
      );
      if (mounted) {
        setState(() {
          _rules = [...?_rules, rule];
          _selectedCapability = null;
        });
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not add review rule.')),
        );
      }
    } finally {
      if (mounted) setState(() => _adding = false);
    }
  }

  Future<void> _remove(ReviewRule rule) async {
    if (_removing.contains(rule.ruleId)) return;
    setState(() => _removing.add(rule.ruleId));
    try {
      await widget.apiClient.removeReviewRule(widget.roleId, rule.ruleId);
      if (mounted) {
        setState(() => _rules = _rules
            ?.where((candidate) => candidate.ruleId != rule.ruleId)
            .toList());
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not remove review rule.')),
        );
      }
    } finally {
      if (mounted) setState(() => _removing.remove(rule.ruleId));
    }
  }

  @override
  Widget build(BuildContext context) {
    final rules = _rules;
    final grants = _grants;
    return Scaffold(
      appBar: AppBar(title: const Text('Auto-review rules')),
      body: _error != null
          ? Center(child: Text(_error!, key: const Key('review-rules-error')))
          : rules == null || grants == null
              ? const Center(child: CircularProgressIndicator())
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (rules.isEmpty)
                      const Text(
                        'No review rules yet.',
                        key: Key('review-rules-empty'),
                      )
                    else
                      for (final rule in rules)
                        ListTile(
                          key: Key('review-rule-${rule.ruleId}'),
                          contentPadding: EdgeInsets.zero,
                          title: Text(rule.capabilityId),
                          subtitle: Text(
                            rule.isAutoCreated
                                ? 'Auto-created by Auto-review'
                                : rule.enabled
                                    ? 'Requires approval'
                                    : 'Disabled',
                          ),
                          trailing: IconButton(
                            key: Key('review-rule-remove-${rule.ruleId}'),
                            tooltip: 'Remove rule',
                            icon: _removing.contains(rule.ruleId)
                                ? const SizedBox(
                                    height: 18,
                                    width: 18,
                                    child: CircularProgressIndicator(
                                        strokeWidth: 2),
                                  )
                                : const Icon(Icons.delete_outline),
                            onPressed: _removing.contains(rule.ruleId)
                                ? null
                                : () => _remove(rule),
                          ),
                        ),
                    const Divider(height: 32),
                    const Text(
                      'Add a review rule',
                      style:
                          TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 8),
                    if (grants.isEmpty)
                      const Text('This bot has no granted capabilities.')
                    else ...[
                      DropdownButtonFormField<String>(
                        key: const Key('review-rule-capability-selector'),
                        initialValue: _selectedCapability,
                        decoration:
                            const InputDecoration(labelText: 'Capability'),
                        items: grants
                            .map(
                              (grant) => DropdownMenuItem(
                                value: grant.capabilityId,
                                child: Text(grant.capabilityId),
                              ),
                            )
                            .toList(),
                        onChanged: _adding
                            ? null
                            : (capabilityId) => setState(
                                () => _selectedCapability = capabilityId),
                      ),
                      const SizedBox(height: 12),
                      ElevatedButton.icon(
                        key: const Key('review-rule-add-button'),
                        onPressed: _selectedCapability == null || _adding
                            ? null
                            : _add,
                        icon: const Icon(Icons.add),
                        label: Text(_adding ? 'Adding…' : 'Add rule'),
                      ),
                    ],
                  ],
                ),
    );
  }
}
