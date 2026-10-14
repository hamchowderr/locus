import type { z } from "zod";
import { DesignBrief, writeBrief } from "./brief.ts";
import { WorkspaceError } from "./paths.ts";
import {
  defaultTemplate,
  renderTemplate,
  type SiteTemplate,
  templateById,
} from "./templates/index.ts";
import type { SiteWorkspace, VersionInfo } from "./workspace.ts";

/**
 * Starts a new site: stores its brief, writes the template's files and saves them as version 1.
 * Refuses a site that already has files, so a start can't overwrite work.
 */
export async function startSite(
  workspace: SiteWorkspace,
  input: { brief: z.input<typeof DesignBrief>; templateId?: string; userId?: string | null },
): Promise<{ brief: DesignBrief; template: SiteTemplate; version: VersionInfo }> {
  if ((await workspace.listFiles()).length > 0 || (await workspace.latestVersion())) {
    throw new WorkspaceError("This site has already been started.");
  }
  const parsed = DesignBrief.parse(input.brief);
  const template = input.templateId ? templateById(input.templateId) : defaultTemplate(parsed);
  if (!template) throw new WorkspaceError(`There's no template called ${input.templateId}.`);
  const brief = await writeBrief(workspace.db, workspace.siteId, {
    ...parsed,
    templateId: template.id,
  });
  await workspace.writeFiles(renderTemplate(template, brief));
  const version = await workspace.saveVersion({
    message: `Started from the ${template.title} template`,
    source: "template",
    userId: input.userId ?? null,
  });
  // biome-ignore lint/style/noNonNullAssertion: the first save of a non-empty draft always saves
  return { brief, template, version: version! };
}
