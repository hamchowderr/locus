/**
 * The site builder's tool calls in a few plain words each, for the step rows in a site's
 * chat. The names and arguments are the builder's tools (packages/builder/src/tools.ts).
 */

type Call = { name: string; args: unknown };
type Result = { result?: unknown; isError?: boolean } | undefined;
export type BuilderStep = { label: string; detail?: string };

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** What a failed call said, when it said something short enough to show. */
function failure(result: Result): string | undefined {
  if (!result?.isError) return undefined;
  const r = result.result;
  const text = str(r) ?? str((r as { message?: unknown; error?: unknown } | null)?.message);
  return text && text.length <= 200 ? text : undefined;
}

function many(paths: unknown): string {
  const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
  if (list.length === 0) return "files";
  if (list.length === 1) return list[0] as string;
  return `${list.length} files`;
}

function label(call: Call, result: Result): string | null {
  const a = (call.args ?? {}) as Record<string, unknown>;
  const out = (result?.result ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case "files": {
      const path = str(a.path) ?? "a file";
      switch (a.action) {
        case "list":
          return "Looked over the site's files";
        case "read":
          return `Read ${path}`;
        case "write":
          return `Wrote ${path}`;
        case "edit":
          return `Edited ${path}`;
        case "delete":
          return `Deleted ${many(a.paths)}`;
      }
      return null;
    }
    case "brief":
      return a.changes ? "Updated the design brief" : "Read the design brief";
    case "run_command":
      return `Ran ${[str(a.command), ...(Array.isArray(a.args) ? a.args : [])].filter(Boolean).join(" ")}`;
    case "add_dependency": {
      const component = str(a.component);
      if (component) return `Added the ${component} component`;
      return `Added ${str(a.package) ?? "a package"}`;
    }
    case "check_site":
      if (!result || result.isError) return "Checked the site";
      return out.ok === false ? "Checked the site and found a problem" : "Checked the site";
    case "preview":
      if (a.logs) return "Read the preview's logs";
      return str(a.path) ? `Opened ${str(a.path)} in the preview` : "Opened the preview";
    case "database":
      return a.action === "apply" ? "Updated the site's database" : "Set up the site's database";
    case "fetch_reference": {
      const url = str(a.url);
      let host: string | undefined;
      try {
        host = url ? new URL(url).hostname : undefined;
      } catch {
        host = undefined;
      }
      return host ? `Looked at ${host}` : "Looked at a reference";
    }
    case "view_reference":
      return "Looked at a reference screenshot";
    case "generate_image":
      return str(a.path) ? `Made an image for ${str(a.path)}` : "Made an image";
    case "crm":
      return "Checked the sub-account in HighLevel";
    case "versions":
      if (a.action === "list") return "Looked at the saved versions";
      if (a.action === "restore") {
        return typeof a.number === "number"
          ? `Went back to version ${a.number}`
          : "Went back to an earlier version";
      }
      // A save that made a version is a card of its own; this covers the rest.
      if (a.action === "save") {
        if (!result) return "Saving a version";
        return out.saved === false ? "Nothing new to save" : "Saved a version";
      }
      return null;
  }
  return null;
}

/** A builder tool call as a step row, or null when it isn't one of the builder's tools. */
export function builderStep(call: Call, result: Result): BuilderStep | null {
  const text = label(call, result);
  if (!text) return null;
  const detail = failure(result);
  return detail ? { label: text, detail } : { label: text };
}

/** A saved version, as a `versions` save call's result says. */
export type SavedVersion = {
  version: number;
  message: string;
  changed: string[];
  /** Why publishing it to the site's repository failed, when it did. */
  publishError?: string;
};

/**
 * The version a `versions` save call made, with the files the same turn wrote, edited or
 * deleted before it. Null when the call isn't a save that made a version.
 */
export function savedVersion(
  call: Call & { id: string },
  result: Result,
  turn: ReadonlyArray<{ call: Call & { id: string }; result: Result }>,
): SavedVersion | null {
  if (call.name !== "versions" || result?.isError) return null;
  const a = (call.args ?? {}) as { action?: unknown; message?: unknown };
  const out = (result?.result ?? {}) as {
    saved?: unknown;
    version?: unknown;
    publishError?: unknown;
  };
  if (a.action !== "save" || out.saved !== true || typeof out.version !== "number") return null;

  // The files changed since the turn's last save, in the order they were first touched.
  const changed: string[] = [];
  for (const { call: c, result: r } of turn) {
    if (c.id === call.id) break;
    if (c.name === "versions" && (c.args as { action?: unknown })?.action === "save") {
      changed.length = 0;
      continue;
    }
    if (c.name !== "files" || r?.isError) continue;
    const args = (c.args ?? {}) as { action?: unknown; path?: unknown; paths?: unknown };
    const paths =
      args.action === "write" || args.action === "edit"
        ? [args.path]
        : args.action === "delete" && Array.isArray(args.paths)
          ? args.paths
          : [];
    for (const p of paths) {
      if (typeof p === "string" && p && !changed.includes(p)) changed.push(p);
    }
  }
  const publishError = str(out.publishError);
  return {
    version: out.version,
    message: str(a.message) ?? `Version ${out.version}`,
    changed,
    ...(publishError ? { publishError } : {}),
  };
}
