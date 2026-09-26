/**
 * Tier-0 model selection for work which can safely prefer a lower-cost lane.
 * This module deliberately has no database or environment access: callers
 * supply the values they observed, making the ordering independently testable.
 */
export type ModelRouteKind = "background" | "chat";
export type ModelRoutingReason = "override" | "background" | "budget_low" | "default";

export interface ModelTarget {
  readonly provider: string | null;
  readonly model: string | null;
}

export interface RouteModelInput {
  readonly kind: ModelRouteKind;
  readonly budgetRemainingUsd: number | null;
  readonly budgetCeilingUsd: number | null;
  readonly roleProvider: string | null | undefined;
  readonly roleModel: string | null | undefined;
  readonly defaults: ModelTarget;
  readonly cheap: ModelTarget;
}

export interface ModelRoute {
  readonly provider: string;
  readonly model: string | null;
  readonly reason: ModelRoutingReason;
}

export const BACKGROUND_PROVIDER_ENV = "OIK_BACKGROUND_PROVIDER";
export const BACKGROUND_MODEL_ENV = "OIK_BACKGROUND_MODEL";

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

function targetOrDefault(target: ModelTarget, defaults: ModelTarget): Pick<ModelRoute, "provider" | "model"> {
  return {
    provider: nonEmpty(target.provider) ?? nonEmpty(defaults.provider) ?? "claude",
    model: nonEmpty(target.model) ?? nonEmpty(defaults.model),
  };
}

function hasTarget(target: ModelTarget): boolean {
  return nonEmpty(target.provider) !== null || nonEmpty(target.model) !== null;
}

function budgetIsLow(remaining: number | null, ceiling: number | null): boolean {
  return remaining !== null && ceiling !== null
    && Number.isFinite(remaining) && Number.isFinite(ceiling) && ceiling > 0
    && remaining < ceiling * 0.2;
}

/**
 * Selects a route in precedence order: role override, configured background
 * route, low-budget background route, then the normal default route.
 */
export function routeModel(input: RouteModelInput): ModelRoute {
  const defaults = { provider: nonEmpty(input.defaults.provider), model: nonEmpty(input.defaults.model) };
  const cheap = { provider: nonEmpty(input.cheap.provider), model: nonEmpty(input.cheap.model) };
  const override = { provider: nonEmpty(input.roleProvider), model: nonEmpty(input.roleModel) };

  if (hasTarget(override)) return { ...targetOrDefault(override, defaults), reason: "override" };
  if (input.kind === "background" && hasTarget(cheap)) {
    if (budgetIsLow(input.budgetRemainingUsd, input.budgetCeilingUsd)) {
      return { ...targetOrDefault(cheap, defaults), reason: "budget_low" };
    }
    return { ...targetOrDefault(cheap, defaults), reason: "background" };
  }
  return { ...targetOrDefault(defaults, defaults), reason: "default" };
}
