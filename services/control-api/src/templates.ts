import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  projectRoleToManifest,
  scanManifestForCredentials,
  templateDigest,
  templateManifestSchema,
  type TemplateManifest,
} from "@oikonomos/templates";

import { DEFAULT_ROLE_CAPABILITIES } from "./defaultCapabilities.js";
import type { ControlApiDeps } from "./ports.js";

function unavailable(reply: FastifyReply): void {
  void reply.code(501).send({ error: "templates are not configured" });
}

async function audit(
  deps: ControlApiDeps,
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (deps.insertAuditEvent === undefined) throw new Error("templates are not configured");
  await deps.insertAuditEvent({ tenantId, actor: `tenant:${tenantId}`, eventType, payload });
}

async function refuse(
  deps: ControlApiDeps,
  tenantId: string,
  eventType: "template.export_refused" | "template.install_refused",
  scan: ReturnType<typeof scanManifestForCredentials>,
  resourceId?: string,
): Promise<{ field_paths: readonly string[]; classes: readonly string[] }> {
  const response = { field_paths: scan.fieldPaths, classes: scan.classes };
  await audit(deps, tenantId, eventType, resourceId === undefined ? response : { ...response, role_id: resourceId });
  return response;
}

/** The one role-creation path used by humans and template installation. */
export async function createRoleWithDefaultCapabilities(
  deps: ControlApiDeps,
  input: { tenantId: string; name: string; title: string; description: string },
) {
  const role = await deps.createRole({ roleId: randomUUID(), ...input });
  const defaultCapabilities = (await deps.listCapabilities()).filter((capability) =>
    (DEFAULT_ROLE_CAPABILITIES as readonly string[]).includes(capability.capabilityId),
  );
  await Promise.all(defaultCapabilities.map((capability) => deps.upsertRoleGrant({
    roleId: role.roleId,
    capabilityId: capability.capabilityId,
    maxTier: capability.defaultTier,
    constraints: {},
  })));
  return role;
}

function asManifest(value: Record<string, unknown>): TemplateManifest | null {
  const parsed = templateManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function selectedMemoryKeys(keys: readonly string[] | undefined): Set<string> {
  return new Set((keys ?? []).map((key) => key.trim()).filter((key) => key.length > 0));
}

/**
 * Re-projects a role's *current* live state into a `TemplateManifest`,
 * restricted to the given `memoryKeys` (export: the caller's explicit
 * opt-in list; status/drift, TASK-289 spec §6.1: the keys already present
 * in the installed manifest, so the comparison is like-for-like rather than
 * flagging every memory fact the role happens to hold today). Shared by the
 * export route and the drift-detection route below so both build the
 * "what does this role look like right now" half of a comparison the exact
 * same way.
 */
async function projectCurrentManifest(
  deps: ControlApiDeps,
  tenantId: string,
  role: Awaited<ReturnType<ControlApiDeps["listRoles"]>>[number],
  memoryKeys: Set<string>,
): Promise<TemplateManifest> {
  if (deps.listEnabledSkillsForRole === undefined) {
    throw new Error("templates are not configured");
  }
  const listEnabledSkillsForRole = deps.listEnabledSkillsForRole;
  const [skills, routines, grants, memories] = await Promise.all([
    listEnabledSkillsForRole(role.roleId),
    deps.listRoutines({ tenantId, roleId: role.roleId }),
    deps.listRoleGrants(role.roleId),
    memoryKeys.size === 0
      ? Promise.resolve([])
      : deps.readProfileTier === undefined
        ? Promise.reject(new Error("template memory is not configured"))
        : deps.readProfileTier({ tenantId, roleId: role.roleId }),
  ]);
  const skillsById = new Map(skills.map((skill) => [skill.skillId, skill]));
  const capabilitiesById = new Map((await deps.listCapabilities()).map((capability) => [capability.capabilityId, capability]));
  return projectRoleToManifest({
    identity: role,
    skills,
    routines: routines.map((routine) => ({
      name: routine.name,
      schedule: routine.schedule,
      definition: routine.definition,
      skillName: routine.skillId === null || routine.skillId === undefined ? null : skillsById.get(routine.skillId)?.name ?? null,
      onMissingSource: routine.onMissingSource ?? "report_and_stop",
      notifyThreshold: routine.notifyThreshold ?? "changes_only",
    })),
    integrations: grants
      .filter((grant) => capabilitiesById.has(grant.capabilityId))
      .map((grant) => ({ capabilityId: grant.capabilityId, requestedMaxTier: grant.maxTier })),
    memories: memories
      .filter((memory) => memory.scope === "agent" && memory.roleId === role.roleId && memory.tier === "profile" && memoryKeys.has(memory.key))
      .map((memory) => ({ key: memory.key, value: memory.value })),
    exportedFromTenantDigest: `tenant:${tenantId}`,
    oikonomosVersion: "v1",
  }, new Date());
}

/**
 * The manifest's top-level content sections — everything except
 * `template_version` (a schema-level constant, can't drift) and
 * `provenance` (export metadata, deliberately excluded from
 * `templateDigest` for the same reason: it never describes the bot).
 */
const TEMPLATE_STATUS_SECTIONS = ["identity", "skills", "routines", "integrations", "memories"] as const;

/**
 * Order-independent (object keys) / order-sensitive (arrays) structural
 * equality. Used instead of a hash comparison because the installed
 * manifest round-trips through a Postgres `jsonb` column, which does not
 * preserve original key order — a naive `JSON.stringify` comparison (or a
 * digest over one) would report false drift on an unchanged role. This
 * route deliberately does not import `@oikonomos/shared`'s `canonicalJson`
 * (not a `control-api` dependency; out of this task's Owned_Paths to add
 * one) — a plain recursive equality check needs no such dependency and is
 * exactly as correct for a yes/no "did this section change" comparison.
 */
function sectionsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sectionsEqual(item, b[index]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    return aKeys.length === bKeys.length && aKeys.every((key) => Object.hasOwn(bRecord, key) && sectionsEqual(aRecord[key], bRecord[key]));
  }
  return false;
}

export function registerTemplateRoutes(app: FastifyInstance, deps: ControlApiDeps): void {
  app.post<{ Params: { roleId: string }; Body: { name?: string; include_memories?: string[] } }>(
    "/roles/:roleId/templates",
    async (request, reply) => {
      if (deps.createBotTemplate === undefined || deps.listEnabledSkillsForRole === undefined || deps.insertAuditEvent === undefined) {
        await unavailable(reply);
        return;
      }
      const name = request.body.name?.trim();
      if (name === undefined || name.length === 0) {
        await reply.code(400).send({ error: "name must not be empty" });
        return;
      }
      const role = (await deps.listRoles({ tenantId: request.tenantId, status: "active" }))
        .find((candidate) => candidate.roleId === request.params.roleId);
      if (role === undefined) {
        await reply.code(404).send({ error: "role not found" });
        return;
      }
      try {
        const memoryKeys = selectedMemoryKeys(request.body.include_memories);
        const manifest = await projectCurrentManifest(deps, request.tenantId, role, memoryKeys);
        const scan = scanManifestForCredentials(manifest);
        if (scan.refused) {
          await reply.code(422).send(await refuse(deps, request.tenantId, "template.export_refused", scan, role.roleId));
          return;
        }
        const template = await deps.createBotTemplate({
          tenantId: request.tenantId,
          name,
          manifest,
          digest: templateDigest(manifest),
          createdBy: `tenant:${request.tenantId}`,
        });
        await audit(deps, request.tenantId, "template.exported", {
          role_id: role.roleId,
          template_id: template.templateId,
          version: template.version,
          digest: template.digest,
        });
        await reply.code(201).send({ templateId: template.templateId, version: template.version, digest: template.digest });
      } catch (error) {
        request.log.warn({ err: error }, "Template export failed");
        await reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.get("/templates", async (request, reply) => {
    if (deps.listBotTemplates === undefined) { await unavailable(reply); return; }
    await reply.code(200).send(await deps.listBotTemplates({ tenantId: request.tenantId }));
  });

  app.post<{ Params: { id: string }; Body: { version?: number; name?: string; include_memories?: string[] } }>(
    "/templates/:id/install",
    async (request, reply) => {
      if (
        deps.getLatestBotTemplate === undefined ||
        deps.getBotTemplate === undefined ||
        deps.createRoleTemplateInstall === undefined ||
        deps.insertAuditEvent === undefined ||
        deps.listEnabledSkillsForRole === undefined
      ) {
        await unavailable(reply);
        return;
      }
      const template = request.body.version === undefined
        ? await deps.getLatestBotTemplate(request.params.id)
        : await deps.getBotTemplate(request.params.id, request.body.version);
      if (template === null || template.tenantId !== request.tenantId) {
        await reply.code(404).send({ error: "template not found" });
        return;
      }
      const manifest = asManifest(template.manifest);
      if (manifest === null) {
        await reply.code(400).send({ error: "stored template has an invalid manifest" });
        return;
      }
      const scan = scanManifestForCredentials(manifest);
      if (scan.refused) {
        await reply.code(422).send(await refuse(deps, request.tenantId, "template.install_refused", scan));
        return;
      }
      try {
        if (manifest.skills.length > 0 && (deps.listSkills === undefined || deps.createSkill === undefined || deps.setSkillEnabledForRole === undefined)) {
          await unavailable(reply);
          return;
        }
        if (manifest.routines.length > 0 && deps.setRoutinePaused === undefined) {
          await unavailable(reply);
          return;
        }
        const memoryKeys = selectedMemoryKeys(request.body.include_memories);
        if (memoryKeys.size > 0 && deps.writeMemoryFact === undefined) {
          await unavailable(reply);
          return;
        }
        const name = request.body.name?.trim() || manifest.identity.name;
        const role = await createRoleWithDefaultCapabilities(deps, {
          tenantId: request.tenantId,
          name,
          title: manifest.identity.title,
          description: manifest.identity.description,
        });
        const existingSkills = manifest.skills.length === 0
          ? []
          : await deps.listSkills!({ tenantId: request.tenantId });
        const skillsByName = new Map(existingSkills.map((skill) => [skill.name, skill]));
        for (const templateSkill of manifest.skills) {
          let skill = skillsByName.get(templateSkill.name);
          if (skill === undefined) {
            skill = await deps.createSkill!({
              tenantId: request.tenantId,
              name: templateSkill.name,
              description: templateSkill.description,
              whenToUse: templateSkill.when_to_use,
              body: templateSkill.body,
              inputs: templateSkill.inputs,
              access: templateSkill.access,
              approvals: templateSkill.approvals,
              failurePolicy: templateSkill.failure_policy,
            });
            skillsByName.set(skill.name, skill);
          }
          await deps.setSkillEnabledForRole!(role.roleId, skill.skillId, true);
        }
        for (const templateRoutine of manifest.routines) {
          const skillId = templateRoutine.skill === null ? null : skillsByName.get(templateRoutine.skill)?.skillId ?? null;
          const routine = await deps.createRoutine({
            tenantId: request.tenantId,
            roleId: role.roleId,
            name: templateRoutine.name,
            schedule: templateRoutine.schedule,
            definition: templateRoutine.definition,
            skillId,
            onMissingSource: templateRoutine.on_missing_source,
            notifyThreshold: templateRoutine.notify_threshold,
          });
          await deps.setRoutinePaused!(routine.routineId, request.tenantId, true);
        }
        for (const memory of manifest.memories) {
          if (!memoryKeys.has(memory.key)) continue;
          await deps.writeMemoryFact!({
            tenantId: request.tenantId,
            roleId: role.roleId,
            scope: "agent",
            tier: "profile",
            key: memory.key,
            value: memory.value,
            source: `template:${template.templateId}@${String(template.version)}`,
          });
        }
        // TASK-293 / spec §6.1: project the role's own manifest now that
        // every install write above has landed (skills enabled, routines
        // paused, opted-in memories written, default-floor grants only --
        // checklist integrations are deliberately not yet granted). That
        // snapshot, not the template's raw manifest, is what "no drift"
        // means for a freshly installed, unedited role -- see
        // template-status below.
        const baselineManifest = await projectCurrentManifest(deps, request.tenantId, role, memoryKeys);
        await deps.createRoleTemplateInstall({
          roleId: role.roleId,
          templateId: template.templateId,
          version: template.version,
          digest: template.digest,
          baselineManifest,
        });
        const capabilities = await deps.listCapabilities();
        const grantChecklist = manifest.integrations.map((integration) => {
          const capability = capabilities.find((candidate) => candidate.capabilityId === integration.capability_id);
          return {
            ...integration,
            status: capability === undefined ? "unknown_capability" : capability.enabled ? "available" : "disabled",
          };
        });
        await audit(deps, request.tenantId, "template.installed", {
          role_id: role.roleId, template_id: template.templateId, version: template.version, digest: template.digest,
        });
        await reply.code(201).send({ role, grant_checklist: grantChecklist, next: "run one supervised turn before enabling routines" });
      } catch (error) {
        request.log.warn({ err: error }, "Template install failed");
        await reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  /**
   * TASK-289 / spec §6.1: "returns `{installed_from | null, drift: boolean,
   * changed: [section...]}` by re-projecting the role (§3.4) and comparing
   * the digest per top-level section with the installed version's
   * manifest." Read-only; §6.2 ("drift is shown, never auto-synced") means
   * this route never writes anything.
   *
   * TASK-293: compares against the install's own `baselineManifest` (the
   * role as it actually looked the moment install finished — name
   * override, opt-in memories, reused tenant skill bodies, un-granted
   * checklist integrations already reflected) rather than the template's
   * raw manifest, which install never promises to reproduce exactly.
   * Comparing against the raw template manifest made a freshly installed,
   * completely unedited role report false drift. Rows written before this
   * column existed have `baselineManifest: null`; those fall back to the
   * pre-293 template-manifest compare so legacy installs keep working,
   * just without the corrected baseline.
   */
  app.get<{ Params: { roleId: string } }>(
    "/roles/:roleId/template-status",
    async (request, reply) => {
      if (deps.getRoleTemplateInstall === undefined || deps.getBotTemplate === undefined || deps.listEnabledSkillsForRole === undefined) {
        await unavailable(reply);
        return;
      }
      const role = (await deps.listRoles({ tenantId: request.tenantId, status: "active" }))
        .find((candidate) => candidate.roleId === request.params.roleId);
      if (role === undefined) {
        await reply.code(404).send({ error: "role not found" });
        return;
      }
      try {
        const install = await deps.getRoleTemplateInstall(role.roleId);
        if (install === null) {
          await reply.code(200).send({ installed_from: null, drift: false, changed: [] });
          return;
        }
        let compareManifest: TemplateManifest;
        if (install.baselineManifest !== null) {
          const baseline = asManifest(install.baselineManifest);
          if (baseline === null) {
            await reply.code(400).send({ error: "stored install baseline has an invalid manifest" });
            return;
          }
          compareManifest = baseline;
        } else {
          // Legacy install row predating TASK-293's baseline_manifest column.
          const installedTemplate = await deps.getBotTemplate(install.templateId, install.version);
          if (installedTemplate === null) {
            throw new Error("installed template version is missing");
          }
          const installedManifest = asManifest(installedTemplate.manifest);
          if (installedManifest === null) {
            await reply.code(400).send({ error: "stored template has an invalid manifest" });
            return;
          }
          compareManifest = installedManifest;
        }
        const memoryKeys = new Set(compareManifest.memories.map((memory) => memory.key));
        const currentManifest = await projectCurrentManifest(deps, request.tenantId, role, memoryKeys);
        const changed = TEMPLATE_STATUS_SECTIONS.filter(
          (section) => !sectionsEqual(currentManifest[section], compareManifest[section]),
        );
        await reply.code(200).send({
          installed_from: { templateId: install.templateId, version: install.version },
          drift: changed.length > 0,
          changed,
        });
      } catch (error) {
        request.log.warn({ err: error }, "Template status check failed");
        await reply.code(400).send({ error: (error as Error).message });
      }
    },
  );
}
