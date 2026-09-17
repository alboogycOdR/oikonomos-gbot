import type { RiskTier } from "@oikonomos/db";

import type {
  TemplateIdentity,
  TemplateIntegration,
  TemplateManifest,
  TemplateMemory,
  TemplateRoutine,
  TemplateSkill,
} from "./manifest.js";
import { templateManifestSchema } from "./manifest.js";

/**
 * `projectRoleToManifest` — ADR-018 §1/§3.4, spec §3.4: "a pure function
 * `projectRoleToManifest(roleBundle)` in `packages/templates`; the route
 * composes it with db reads. The pure function cannot see grants, secrets
 * or history because its input type has no fields for them." Every input
 * type below is a plain, already-fetched value bundle -- no `DatabaseOptions`,
 * no id from the source tenant beyond what a manifest is allowed to carry,
 * no grants, no secrets. `exportedAt` is passed in rather than read from
 * `new Date()` inside this function, so the function stays deterministic
 * and testable without faking the clock.
 */

export interface RoleIdentityInput {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly instructions: string | null;
  readonly provider: string | null;
  readonly model: string | null;
}

export interface RoleSkillInput {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly whenToUse: string | null;
  readonly body: string;
  readonly inputs: readonly Record<string, unknown>[];
  readonly access: readonly string[];
  readonly approvals: readonly string[];
  readonly failurePolicy: Record<string, unknown>;
}

export interface RoleRoutineInput {
  readonly name: string;
  readonly schedule: string | null;
  readonly definition: Record<string, unknown>;
  /** The referenced skill's name, or null. Must name a skill in the same bundle (spec §2.3). */
  readonly skillName: string | null;
  readonly onMissingSource: "report_and_stop";
  readonly notifyThreshold: "changes_only";
}

export interface RoleIntegrationInput {
  readonly capabilityId: string;
  readonly requestedMaxTier: RiskTier;
}

export interface ProfileMemoryInput {
  readonly key: string;
  readonly value: string;
}

/**
 * Everything `projectRoleToManifest` needs, and by type, nothing else: no
 * `role_grants`, no `secret://` refs or secret values, no approvals rows,
 * no attachment/thread/message content, no spend or audit history, no
 * source-tenant id beyond `exportedFromTenantDigest` (itself a digest, not
 * an id) (spec §1.3).
 */
export interface RoleBundle {
  readonly identity: RoleIdentityInput;
  readonly skills: readonly RoleSkillInput[];
  readonly routines: readonly RoleRoutineInput[];
  readonly integrations: readonly RoleIntegrationInput[];
  /** Only the profile-tier facts the exporter explicitly opted in (spec §1.2). */
  readonly memories: readonly ProfileMemoryInput[];
  readonly exportedFromTenantDigest: string;
  readonly oikonomosVersion: string;
}

/** Thrown when a routine names a skill that is not present in the same bundle (spec §2.3). */
export class UnknownRoutineSkillError extends Error {
  public override readonly name = "UnknownRoutineSkillError";
  public readonly routineName: string;
  public readonly skillName: string;

  public constructor(routineName: string, skillName: string) {
    super(
      `routine "${routineName}" references skill "${skillName}", which is not present in this bundle's skills.`,
    );
    this.routineName = routineName;
    this.skillName = skillName;
  }
}

function projectIdentity(input: RoleIdentityInput): TemplateIdentity {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    instructions: input.instructions,
    provider: input.provider,
    model: input.model,
  };
}

function projectSkill(input: RoleSkillInput): TemplateSkill {
  return {
    name: input.name,
    version: input.version,
    description: input.description,
    when_to_use: input.whenToUse,
    body: input.body,
    inputs: [...input.inputs],
    access: [...input.access],
    approvals: [...input.approvals],
    failure_policy: { ...input.failurePolicy },
  };
}

/**
 * Projects one routine. `paused` is always `true` and `definition` never
 * carries a budget field on the way in (spec §2.3: "Routines in a manifest
 * are always `paused: true` and carry no budget") -- this function trusts
 * its caller to have already stripped `budgetUsd` from `definition` before
 * building the bundle, since that stripping is itself real domain logic
 * the caller (TASK-278's export route) owns, not a concern of the pure
 * projection.
 */
function projectRoutine(input: RoleRoutineInput, skillNames: ReadonlySet<string>): TemplateRoutine {
  if (input.skillName !== null && !skillNames.has(input.skillName)) {
    throw new UnknownRoutineSkillError(input.name, input.skillName);
  }
  return {
    name: input.name,
    schedule: input.schedule,
    definition: { ...input.definition },
    skill: input.skillName,
    on_missing_source: input.onMissingSource,
    notify_threshold: input.notifyThreshold,
    paused: true,
  };
}

function projectIntegration(input: RoleIntegrationInput): TemplateIntegration {
  return {
    capability_id: input.capabilityId,
    requested_max_tier: input.requestedMaxTier,
  };
}

function projectMemory(input: ProfileMemoryInput): TemplateMemory {
  return {
    key: input.key,
    value: input.value,
    scope: "agent",
    tier: "profile",
  };
}

/**
 * Projects a role bundle into a template manifest. Pure: no I/O, no clock
 * read, no randomness. Validates the result against
 * {@link templateManifestSchema} before returning, so a caller can never
 * receive a manifest this package's own schema would reject.
 */
export function projectRoleToManifest(bundle: RoleBundle, exportedAt: Date): TemplateManifest {
  const skillNames = new Set(bundle.skills.map((skill) => skill.name));

  const manifest: TemplateManifest = {
    template_version: 1,
    identity: projectIdentity(bundle.identity),
    skills: bundle.skills.map(projectSkill),
    routines: bundle.routines.map((routine) => projectRoutine(routine, skillNames)),
    integrations: bundle.integrations.map(projectIntegration),
    memories: bundle.memories.map(projectMemory),
    provenance: {
      exported_at: exportedAt.toISOString(),
      exported_from_tenant_digest: bundle.exportedFromTenantDigest,
      oikonomos_version: bundle.oikonomosVersion,
    },
  };

  return templateManifestSchema.parse(manifest);
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  function bundle(overrides: Partial<RoleBundle> = {}): RoleBundle {
    return {
      identity: {
        name: "support-bot",
        title: "Support Bot",
        description: "Handles support tickets.",
        instructions: "Be courteous.",
        provider: null,
        model: null,
      },
      skills: [],
      routines: [],
      integrations: [],
      memories: [],
      exportedFromTenantDigest: "tenant-digest-abc",
      oikonomosVersion: "0.0.0",
      ...overrides,
    };
  }

  describe("projectRoleToManifest", () => {
    it("projects identity, skills, integrations, and memories field-for-field", () => {
      const manifest = projectRoleToManifest(
        bundle({
          skills: [
            {
              name: "triage",
              version: 1,
              description: "Triage a ticket.",
              whenToUse: "On a new ticket.",
              body: "Read and classify.",
              inputs: [],
              access: [],
              approvals: [],
              failurePolicy: {},
            },
          ],
          integrations: [{ capabilityId: "email.send", requestedMaxTier: "T2_internal" }],
          memories: [{ key: "tone", value: "formal" }],
        }),
        new Date("2026-09-17T00:00:00.000Z"),
      );

      expect(manifest.identity.name).toBe("support-bot");
      expect(manifest.skills).toHaveLength(1);
      expect(manifest.skills[0]!.name).toBe("triage");
      expect(manifest.integrations).toEqual([
        { capability_id: "email.send", requested_max_tier: "T2_internal" },
      ]);
      expect(manifest.memories).toEqual([{ key: "tone", value: "formal", scope: "agent", tier: "profile" }]);
      expect(manifest.provenance).toEqual({
        exported_at: "2026-09-17T00:00:00.000Z",
        exported_from_tenant_digest: "tenant-digest-abc",
        oikonomos_version: "0.0.0",
      });
    });

    it("always forces routines to paused: true regardless of input", () => {
      const manifest = projectRoleToManifest(
        bundle({
          skills: [
            {
              name: "triage",
              version: 1,
              description: "d",
              whenToUse: null,
              body: "b",
              inputs: [],
              access: [],
              approvals: [],
              failurePolicy: {},
            },
          ],
          routines: [
            {
              name: "daily",
              schedule: "0 9 * * *",
              definition: { kind: "report" },
              skillName: "triage",
              onMissingSource: "report_and_stop",
              notifyThreshold: "changes_only",
            },
          ],
        }),
        new Date("2026-09-17T00:00:00.000Z"),
      );
      expect(manifest.routines[0]!.paused).toBe(true);
      expect(manifest.routines[0]!.skill).toBe("triage");
    });

    it("throws UnknownRoutineSkillError when a routine references a skill absent from the bundle", () => {
      expect(() =>
        projectRoleToManifest(
          bundle({
            routines: [
              {
                name: "daily",
                schedule: null,
                definition: {},
                skillName: "nonexistent-skill",
                onMissingSource: "report_and_stop",
                notifyThreshold: "changes_only",
              },
            ],
          }),
          new Date("2026-09-17T00:00:00.000Z"),
        ),
      ).toThrow(/nonexistent-skill/);
    });

    it("is deterministic: the same bundle and exportedAt project to an identical manifest", () => {
      const b = bundle();
      const at = new Date("2026-09-17T00:00:00.000Z");
      expect(projectRoleToManifest(b, at)).toEqual(projectRoleToManifest(b, at));
    });

    it("never produces a manifest field for grants, secrets, or a source-tenant id -- by type, RoleBundle has no such field", () => {
      const manifest = projectRoleToManifest(bundle(), new Date("2026-09-17T00:00:00.000Z"));
      const serialized = JSON.stringify(manifest);
      expect(serialized).not.toContain("role_grants");
      expect(serialized).not.toContain("secret://");
    });
  });
}
