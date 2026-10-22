/**
 * The site builder's tool calls in a few plain words each, for the step rows in a site's
 * chat. The names and arguments are the builder's tools (packages/builder/src/tools.ts).
 */

type Call = { name: string; args: unknown };
type Result = { result?: unknown; isError?: boolean } | undefined;
export type BuilderStep = { label: string; detail?: string; failed?: boolean };

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Whether a call failed. The builder's tools report their own failures as a normal result
 * with an `error` message (packages/builder/src/tools.ts, `recoverable`); input that doesn't
 * fit a tool comes back as `{ error: true, message }`; a thrown tool is `isError`.
 */
export function callFailed(result: Result): boolean {
  if (!result) return false;
  if (result.isError) return true;
  const r = result.result as { error?: unknown } | null | undefined;
  return typeof r === "object" && r !== null && r.error !== undefined && r.error !== false;
}

/** What a failed call said, when it said something short enough to show. */
function failure(result: Result): string | undefined {
  if (!callFailed(result)) return undefined;
  const r = result?.result;
  const said = r as { message?: unknown; error?: unknown } | null | undefined;
  const text = str(r) ?? str(said?.error) ?? str(said?.message);
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
      switch (a.action) {
        case "add_booking":
          return "Added a booking form";
        case "add_calendar_embed":
          return "Added a booking calendar";
        case "add_checkout":
          return "Added a Buy button";
        case "add_tracking":
          return "Added the tracking script to every page";
        case "use_media":
          return "Used an image from the Media Library";
        case "media":
          return "Looked in the Media Library";
        case "products":
          return "Looked at the products in HighLevel";
        case "calendars":
          return "Looked at the calendars in HighLevel";
      }
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
        if (callFailed(result)) return "Couldn't save a version";
        return out.saved === false ? "Nothing new to save" : "Saved a version";
      }
      return null;
  }
  return null;
}

/**
 * The first line of a build's output that says what went wrong (`Type error: …`, `Module not
 * found: …`), else its first line, at most 200 characters.
 */
export function buildError(output: unknown, step?: unknown): string {
  const lines = (typeof output === "string" ? output : "")
    .split("\n")
    .map((line) => line.trim())
    // The screen around tool output (`<<<untrusted …>>>`, `<<<end untrusted>>>`) isn't the build's.
    .filter((line) => line && line !== "…" && !line.startsWith("<<<"));
  const line =
    lines.find((l) => /error/i.test(l)) ??
    lines.find((l) => /cannot|can't|not found|failed/i.test(l)) ??
    lines[0] ??
    `The ${str(step) ?? "build"} failed.`;
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
}

/**
 * Why a `check_site` call found the site doesn't build, or undefined when it built (or isn't a
 * check that ran). A failed build is a normal result `{ ok: false, step, output }`, not an error.
 */
export function checkFailure(call: Pick<Call, "name">, result: Result): string | undefined {
  if (call.name !== "check_site" || !result || callFailed(result)) return undefined;
  const out = result.result as { ok?: unknown; step?: unknown; output?: unknown } | undefined;
  return out?.ok === false ? buildError(out.output, out.step) : undefined;
}

/** A builder tool call as a step row, or null when it isn't one of the builder's tools. */
export function builderStep(call: Call, result: Result): BuilderStep | null {
  const text = label(call, result);
  if (!text) return null;
  const broken = checkFailure(call, result);
  if (broken) return { label: text, detail: broken, failed: true };
  if (!callFailed(result)) return { label: text };
  const detail = failure(result);
  return detail ? { label: text, detail, failed: true } : { label: text, failed: true };
}

type Part = { type: string; name?: unknown; result?: unknown; isError?: unknown };

/**
 * What the newest `check_site` in a conversation found: the problem in a line when the build
 * failed, null when it passed or nothing has checked the site yet. So a failure shows until a
 * later check passes.
 */
export function lastCheckFailure(
  messages: ReadonlyArray<{ content: ReadonlyArray<Part> }>,
): string | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const content = messages[m]?.content ?? [];
    for (let p = content.length - 1; p >= 0; p--) {
      const part = content[p];
      if (part?.type !== "tool_result" || part.name !== "check_site") continue;
      const result = { result: part.result, isError: part.isError === true };
      // A check that couldn't run says nothing about the build either way.
      if (callFailed(result)) continue;
      return checkFailure({ name: "check_site" }, result) ?? null;
    }
  }
  return null;
}

/** Tools that change the site's files without naming them: components, images, CRM pieces. */
const OTHER_CHANGES = new Set(["add_dependency", "generate_image", "crm", "database"]);

/** Whether a call from OTHER_CHANGES wrote files (the others only look things up). */
function wroteFiles(name: string, action: unknown): boolean {
  if (name === "crm") return typeof action === "string" && /^(add_|use_media$)/.test(action);
  if (name === "database") return action === "add";
  return true;
}

/**
 * Whether a call changed the site, so the preview and its version picker need loading again: a
 * file written, edited or deleted, a version saved or restored, or a tool from OTHER_CHANGES
 * that wrote files.
 */
export function changedFiles(call: Call, result: Result): boolean {
  if (!result || callFailed(result)) return false;
  const action = ((call.args ?? {}) as { action?: unknown }).action;
  if (call.name === "files") return action === "write" || action === "edit" || action === "delete";
  if (call.name === "versions") {
    if (action === "restore") return true;
    return action === "save" && (result.result as { saved?: unknown })?.saved === true;
  }
  return OTHER_CHANGES.has(call.name) && wroteFiles(call.name, action);
}

/** Whether any of the calls named by `ids` changed the site's files, as the conversation has them. */
export function callsChangedFiles(
  messages: ReadonlyArray<{ content: ReadonlyArray<Part & { id?: unknown; args?: unknown }> }>,
  ids: ReadonlySet<string>,
): boolean {
  const calls = new Map<string, Call>();
  const results = new Map<string, Result>();
  for (const { content } of messages) {
    for (const part of content) {
      if (typeof part.id !== "string" || !ids.has(part.id)) continue;
      if (part.type === "tool_call" && typeof part.name === "string") {
        calls.set(part.id, { name: part.name, args: part.args });
      } else if (part.type === "tool_result") {
        results.set(part.id, { result: part.result, isError: part.isError === true });
      }
    }
  }
  return [...calls].some(([id, call]) => changedFiles(call, results.get(id)));
}

/** A saved version, as a `versions` save call's result says. */
export type SavedVersion = {
  version: number;
  message: string;
  changed: string[];
  /** Whether the turn also changed files some other way (components, images, booking forms). */
  more: boolean;
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
  if (call.name !== "versions" || callFailed(result)) return null;
  const a = (call.args ?? {}) as { action?: unknown; message?: unknown };
  const out = (result?.result ?? {}) as {
    saved?: unknown;
    version?: unknown;
    publishError?: unknown;
  };
  if (a.action !== "save" || out.saved !== true || typeof out.version !== "number") return null;

  // The files changed since the turn's last save, in the order they were first touched.
  const changed: string[] = [];
  let more = false;
  for (const { call: c, result: r } of turn) {
    if (c.id === call.id) break;
    if (!r || callFailed(r)) continue;
    const args = (c.args ?? {}) as { action?: unknown; path?: unknown; paths?: unknown };
    if (c.name === "versions") {
      // Only a save that made a version starts the list again.
      if (args.action === "save" && (r.result as { saved?: unknown })?.saved === true) {
        changed.length = 0;
        more = false;
      }
      continue;
    }
    if (OTHER_CHANGES.has(c.name)) {
      if (wroteFiles(c.name, args.action)) more = true;
      continue;
    }
    if (c.name !== "files") continue;
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
    more,
    ...(publishError ? { publishError } : {}),
  };
}
