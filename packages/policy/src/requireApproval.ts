/** JSON-shaped, caller-described action target. This package performs no I/O. */
export type TargetValue =
  | null
  | boolean
  | number
  | string
  | readonly TargetValue[]
  | { readonly [key: string]: TargetValue };

/**
 * The persisted rule data needed by the policy resolver. An empty predicate
 * matches every target for its capability.
 */
export interface RequireApprovalRule {
  readonly capabilityId: string;
  readonly enabled: boolean;
  readonly targetPredicate: Readonly<Record<string, TargetValue>>;
}

/**
 * Matches a target deterministically. Predicate objects are subsets of their
 * corresponding target objects; arrays and scalars must match exactly.
 * Invalid/missing target fields never match, which keeps promotion fail-safe.
 */
export function matchesRequireApprovalRule(
  rule: RequireApprovalRule,
  capabilityId: string,
  target: Readonly<Record<string, TargetValue>>,
): boolean {
  return (
    rule.enabled &&
    rule.capabilityId === capabilityId &&
    matchesTargetValue(rule.targetPredicate, target)
  );
}

function matchesTargetValue(predicate: TargetValue, target: TargetValue): boolean {
  if (predicate === null || typeof predicate !== "object") {
    return Object.is(predicate, target);
  }

  if (Array.isArray(predicate)) {
    return (
      Array.isArray(target) &&
      predicate.length === target.length &&
      predicate.every((value, index) => matchesTargetValue(value, target[index]!))
    );
  }

  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    return false;
  }

  const targetObject = target as Readonly<Record<string, TargetValue>>;
  return Object.entries(predicate).every(([key, value]) => {
    if (!Object.hasOwn(targetObject, key)) {
      return false;
    }

    return matchesTargetValue(value, targetObject[key]!);
  });
}
