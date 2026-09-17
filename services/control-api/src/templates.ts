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
        const [skills, routines] = await Promise.all([
          deps.listEnabledSkillsForRole(role.roleId),
          deps.listRoutines({ tenantId: request.tenantId, roleId: role.roleId }),
        ]);
        const skillsById = new Map(skills.map((skill) => [skill.skillId, skill]));
        const manifest = projectRoleToManifest({
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
          integrations: [],
          // Memory is opt-in and has no control-api port in this task's scope.
          memories: [],
          exportedFromTenantDigest: `tenant:${request.tenantId}`,
          oikonomosVersion: "v1",
        }, new Date());
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

  app.post<{ Params: { id: string }; Body: { version?: number; name?: string } }>(
    "/templates/:id/install",
    async (request, reply) => {
      if (deps.getLatestBotTemplate === undefined || deps.getBotTemplate === undefined || deps.createRoleTemplateInstall === undefined || deps.insertAuditEvent === undefined) {
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
        const name = request.body.name?.trim() || manifest.identity.name;
        const role = await createRoleWithDefaultCapabilities(deps, {
          tenantId: request.tenantId,
          name,
          title: manifest.identity.title,
          description: manifest.identity.description,
        });
        await deps.createRoleTemplateInstall({
          roleId: role.roleId,
          templateId: template.templateId,
          version: template.version,
          digest: template.digest,
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
}
