/** Where to go after signing in or up: a path on this site only, never another host. */
export function safeNext(value: unknown, fallback: string): string {
  const path = typeof value === "string" ? value : "";
  const local = path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
  return local ? path : fallback;
}
