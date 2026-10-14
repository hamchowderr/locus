export class InvalidPathError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Invalid project path ${JSON.stringify(path)}: ${reason}`);
    this.name = "InvalidPathError";
    this.path = path;
  }
}

/**
 * Checks a project-relative path and returns it normalised (POSIX separators, no "." segments,
 * no duplicate or trailing slashes). Throws `InvalidPathError` for anything that could leave the
 * project root: absolute paths, drive letters, "..", NUL, or a path that names the root itself.
 */
export function validatePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new InvalidPathError(String(path), "empty");
  }
  if (path.includes("\0")) throw new InvalidPathError(path, "contains NUL");
  if (path.includes("\\")) throw new InvalidPathError(path, "use forward slashes");
  if (path.startsWith("/")) throw new InvalidPathError(path, "absolute paths are not allowed");
  if (/^[A-Za-z]:/.test(path)) throw new InvalidPathError(path, "absolute paths are not allowed");
  if (path.startsWith("~")) throw new InvalidPathError(path, "home-relative paths are not allowed");

  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new InvalidPathError(path, '".." is not allowed');
    segments.push(segment);
  }
  if (segments.length === 0) throw new InvalidPathError(path, "names the project root");
  return segments.join("/");
}
