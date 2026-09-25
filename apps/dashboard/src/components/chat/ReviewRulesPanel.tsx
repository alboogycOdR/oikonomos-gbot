import { useEffect, useState } from "react";

import {
  createReviewRule,
  listReviewRules,
  listRoleGrants,
  removeReviewRule,
  type ReviewRule,
  type RoleGrant,
} from "../../lib/api";

export interface ReviewRulesPanelProps {
  roleId: string;
}

/** Per-bot Require-Approval rules; only existing grants are offered for creation. */
export function ReviewRulesPanel({ roleId }: ReviewRulesPanelProps) {
  const [rules, setRules] = useState<ReviewRule[] | null>(null);
  const [grants, setGrants] = useState<RoleGrant[] | null>(null);
  const [selectedCapability, setSelectedCapability] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingRuleId, setRemovingRuleId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listReviewRules(roleId), listRoleGrants(roleId)])
      .then(([nextRules, nextGrants]) => {
        if (!cancelled) {
          setRules(nextRules);
          setGrants(nextGrants);
          setError(null);
          setSelectedCapability("");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load review rules.");
      });
    return () => { cancelled = true; };
  }, [roleId]);

  const addRule = async () => {
    if (selectedCapability === "" || saving) return;
    setSaving(true);
    try {
      const rule = await createReviewRule(roleId, selectedCapability);
      setRules((current) => current === null ? [rule] : [...current, rule]);
      setSelectedCapability("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add review rule.");
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async (rule: ReviewRule) => {
    if (removingRuleId !== null) return;
    setRemovingRuleId(rule.ruleId);
    try {
      await removeReviewRule(roleId, rule.ruleId);
      setRules((current) => current?.filter((candidate) => candidate.ruleId !== rule.ruleId) ?? current);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove review rule.");
    } finally {
      setRemovingRuleId(null);
    }
  };

  return (
    <section aria-labelledby="review-rules-heading" className="border-t border-chrome-border pt-4">
      <h2 id="review-rules-heading" className="text-sm font-medium text-slate-100">Auto-review rules</h2>
      <p className="mb-2 text-xs text-slate-500">Choose actions that always need approval.</p>
      {error !== null ? <p role="alert" className="mb-2 text-xs text-red-400">{error}</p> : null}
      {rules === null || grants === null ? <p className="text-xs text-slate-500">Loading review rules…</p> : <>
        <ul aria-label="Review rules" className="space-y-2">
          {rules.map((rule) => (
            <li key={rule.ruleId} className="flex items-center gap-2 rounded-lg bg-surface-raised p-2">
              <span className="min-w-0 flex-1 text-sm text-slate-200">{rule.capabilityId}</span>
              <span className="text-[10px] uppercase text-slate-500">{rule.createdBy === "auto-review" ? "Auto-review" : rule.enabled ? "Requires approval" : "Disabled"}</span>
              <button type="button" disabled={removingRuleId === rule.ruleId} onClick={() => void removeRule(rule)} className="text-xs text-red-400 disabled:opacity-50">Remove</button>
            </li>
          ))}
          {rules.length === 0 ? <li className="text-xs text-slate-500">No review rules yet.</li> : null}
        </ul>
        <div className="mt-3 flex gap-2">
          <select aria-label="Capability for review rule" value={selectedCapability} disabled={saving || grants.length === 0} onChange={(event) => setSelectedCapability(event.currentTarget.value)} className="min-w-0 flex-1 rounded bg-surface-raised p-2 text-xs text-slate-200">
            <option value="">{grants.length === 0 ? "No granted capabilities" : "Select a capability"}</option>
            {grants.map((grant) => <option key={grant.capabilityId} value={grant.capabilityId}>{grant.capabilityId}</option>)}
          </select>
          <button type="button" disabled={selectedCapability === "" || saving} onClick={() => void addRule()} className="rounded bg-bubble-user px-3 text-xs text-white disabled:opacity-50">{saving ? "Adding…" : "Add rule"}</button>
        </div>
      </>}
    </section>
  );
}
