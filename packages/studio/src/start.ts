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
  const parsed = DesignBrief.parse(input.brief);
  const template = input.templateId ? templateById(input.templateId) : defaultTemplate(parsed);
  if (!template) throw new WorkspaceError(`There's no template called ${input.templateId}.`);
  const brief = DesignBrief.parse({ ...parsed, templateId: template.id });
  const files = renderTemplate(template, brief);
  if ((await workspace.listFiles()).length > 0 || (await workspace.latestVersion())) {
    throw new WorkspaceError("This site has already been started.");
  }
  // Files first: if anything after fails, the site is still empty and can be started again.
  // A second start racing this one finds the draft taken, or loses the version number.
  await workspace.writeFiles(files);
  let version: VersionInfo | null;
  try {
    version = await workspace.saveVersion({
      message: `Started from the ${template.title} template`,
      source: "template",
      userId: input.userId ?? null,
    });
  } catch (error) {
    if (!(await workspace.latestVersion())) await workspace.deleteFiles(files.map((f) => f.path));
    throw error;
  }
  if (version?.number !== 1) {
    throw new WorkspaceError("This site has already been started.");
  }
  await writeBrief(workspace.db, workspace.siteId, brief);
  return { brief, template, version };
}
