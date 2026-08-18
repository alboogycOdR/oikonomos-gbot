import { riskTiers } from "@oikonomos/db";
import { z } from "zod";

import { inspectUrlRef } from "./urlRef.js";

/**
 * Zod schema for a connector manifest (Handover §4.4 content contract).
 *
 * The tier vocabulary is imported from `@oikonomos/db` — do not redeclare it.
 * `account_ownership` is a literal `basileia` (N5). Any other value or
 * absence is a named-field rejection.
 */
const [headTier, ...tailTiers] = riskTiers;
if (headTier === undefined) {
  throw new Error("UNOBSERVABLE: @oikonomos/db riskTiers is empty");
}

export const riskTierSchema = z.enum([headTier, ...tailTiers]);

const urlRefSchema = z.string().superRefine((value, ctx) => {
  const verdict = inspectUrlRef(value);
  if (!verdict.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: verdict.message,
    });
  }
});

const toolSchema = z
  .object({
    tool_name: z.string().min(1),
    capability_id: z.string().min(1),
    default_tier: riskTierSchema,
    enabled: z.boolean().optional(),
  })
  .strict();

const roleGrantSchema = z
  .object({
    role_id: z.string().min(1),
    max_tier: riskTierSchema,
    constraints: z
      .object({
        rate_per_hour: z.number().optional(),
        domains: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();

export const connectorManifestSchema = z
  .object({
    connector_id: z.string().min(1),
    account_ownership: z.literal("basileia"),
    mcp_server: z
      .object({
        name: z.string().min(1),
        transport: z.string().min(1),
        url_ref: urlRefSchema,
      })
      .strict(),
    oauth_scopes: z.array(z.string().min(1)).optional(),
    tools: z.array(toolSchema).min(1),
    role_grants: z.array(roleGrantSchema),
    evals: z
      .object({
        suite: z
          .string()
          .min(1)
          .refine((value) => value.startsWith("evals/golden/"), {
            message: "evals.suite must be a path under evals/golden/",
          }),
        min_pass_rate: z.number().min(0.9).max(1),
      })
      .strict(),
    review: z
      .object({
        onboarded_by: z.string(),
        date: z.string(),
        scope_justification: z.string(),
      })
      .strict(),
  })
  .strict();

export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;

/** Re-export the db tuple by identity — no second tier vocabulary. */
export { riskTiers };
