import { riskTiers } from "@oikonomos/db";
import { z } from "zod";

/**
 * The bot template manifest — ADR-018 §1, specs/OIKONOMOS_TEMPLATES_v1.0.md
 * §2.1. A strict, versioned, zero-I/O zod schema. `packages/templates` has
 * no I/O imports of its own (mirrors `packages/policy`'s convention); the
 * only cross-package import here is `@oikonomos/db`'s `riskTiers` constant
 * (a plain, statically-defined tuple, never invoked as I/O) so this schema
 * never declares a second tier vocabulary, exactly as
 * `packages/connectors/src/manifest/schema.ts` already does for the same
 * reason.
 *
 * By construction (ADR-018 §1, spec §1.3) this type has NO fields for
 * grants, secret values or `secret://` refs, approvals, attachments,
 * threads/messages, sandbox content, spend, audit, or any id from the
 * source tenant — exclusion is by type, not by a filter someone could
 * forget to apply.
 */

const [headTier, ...tailTiers] = riskTiers;
if (headTier === undefined) {
  throw new Error("UNOBSERVABLE: @oikonomos/db riskTiers is empty");
}

/** Re-export of the single risk-tier vocabulary — never redeclare it. */
export const templateRiskTierSchema = z.enum([headTier, ...tailTiers]);

const templateIdentitySchema = z
  .object({
    name: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    instructions: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
  })
  .strict();

const templateSkillSchema = z
  .object({
    name: z.string().min(1),
    version: z.number().int().positive(),
    description: z.string(),
    when_to_use: z.string().nullable(),
    body: z.string(),
    inputs: z.array(z.record(z.string(), z.unknown())),
    access: z.array(z.string()),
    approvals: z.array(z.string()),
    failure_policy: z.record(z.string(), z.unknown()),
  })
  .strict();

const templateRoutineSchema = z
  .object({
    name: z.string().min(1),
    schedule: z.string().nullable(),
    definition: z.record(z.string(), z.unknown()),
    skill: z.string().nullable(),
    on_missing_source: z.literal("report_and_stop"),
    notify_threshold: z.literal("changes_only"),
    /** Always `true` — spec §2.3: a template never carries a live routine. */
    paused: z.literal(true),
  })
  .strict();

const templateIntegrationSchema = z
  .object({
    capability_id: z.string().min(1),
    requested_max_tier: templateRiskTierSchema,
  })
  .strict();

const templateMemorySchema = z
  .object({
    key: z.string().min(1),
    value: z.string(),
    scope: z.literal("agent"),
    tier: z.literal("profile"),
  })
  .strict();

const templateProvenanceSchema = z
  .object({
    exported_at: z.string().min(1),
    exported_from_tenant_digest: z.string().min(1),
    oikonomos_version: z.string().min(1),
  })
  .strict();

export const templateManifestSchema = z
  .object({
    template_version: z.literal(1),
    identity: templateIdentitySchema,
    skills: z.array(templateSkillSchema),
    routines: z.array(templateRoutineSchema),
    integrations: z.array(templateIntegrationSchema),
    memories: z.array(templateMemorySchema),
    provenance: templateProvenanceSchema,
  })
  .strict();

export type TemplateManifest = z.infer<typeof templateManifestSchema>;
export type TemplateIdentity = z.infer<typeof templateIdentitySchema>;
export type TemplateSkill = z.infer<typeof templateSkillSchema>;
export type TemplateRoutine = z.infer<typeof templateRoutineSchema>;
export type TemplateIntegration = z.infer<typeof templateIntegrationSchema>;
export type TemplateMemory = z.infer<typeof templateMemorySchema>;
export type TemplateProvenance = z.infer<typeof templateProvenanceSchema>;

/** Re-export of the db risk-tier tuple by identity — no second vocabulary. */
export { riskTiers };

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  function validManifest(): TemplateManifest {
    return {
      template_version: 1,
      identity: {
        name: "support-bot",
        title: "Support Bot",
        description: "Handles support tickets.",
        instructions: "Be courteous.",
        provider: null,
        model: null,
      },
      skills: [
        {
          name: "triage",
          version: 1,
          description: "Triage a ticket.",
          when_to_use: "When a new ticket arrives.",
          body: "Read the ticket and classify it.",
          inputs: [],
          access: [],
          approvals: [],
          failure_policy: {},
        },
      ],
      routines: [
        {
          name: "daily-report",
          schedule: "0 9 * * *",
          definition: { kind: "report" },
          skill: "triage",
          on_missing_source: "report_and_stop",
          notify_threshold: "changes_only",
          paused: true,
        },
      ],
      integrations: [{ capability_id: "email.send", requested_max_tier: "T2_internal" }],
      memories: [{ key: "tone", value: "formal", scope: "agent", tier: "profile" }],
      provenance: {
        exported_at: "2026-09-17T00:00:00.000Z",
        exported_from_tenant_digest: "digest-abc",
        oikonomos_version: "0.0.0",
      },
    };
  }

  describe("templateManifestSchema", () => {
    it("accepts a well-formed manifest", () => {
      expect(templateManifestSchema.parse(validManifest())).toEqual(validManifest());
    });

    it("rejects a template_version other than 1", () => {
      const bad = { ...validManifest(), template_version: 2 };
      expect(() => templateManifestSchema.parse(bad)).toThrow();
    });

    it("rejects a routine that is not paused", () => {
      const bad = validManifest();
      bad.routines[0]!.paused = false as unknown as true;
      expect(() => templateManifestSchema.parse(bad)).toThrow();
    });

    it("rejects an unknown field anywhere in the manifest (strict schema)", () => {
      const bad = { ...validManifest(), unexpected: "field" };
      expect(() => templateManifestSchema.parse(bad)).toThrow();
    });

    it("rejects a role_grants-shaped field on integrations (grants are never part of a manifest)", () => {
      const bad = validManifest();
      (bad.integrations[0] as unknown as Record<string, unknown>).max_tier = "T4_irreversible";
      expect(() => templateManifestSchema.parse(bad)).toThrow();
    });

    it("rejects a memory scope other than 'agent' or tier other than 'profile'", () => {
      const badScope = validManifest();
      (badScope.memories[0] as unknown as Record<string, unknown>).scope = "project";
      expect(() => templateManifestSchema.parse(badScope)).toThrow();

      const badTier = validManifest();
      (badTier.memories[0] as unknown as Record<string, unknown>).tier = "log";
      expect(() => templateManifestSchema.parse(badTier)).toThrow();
    });
  });
}
