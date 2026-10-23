/**
 * The connectors a person turned off for a sub-account's chat (the composer's + menu), kept in
 * this browser. Each turn sends the list (`connectorsOff`), and the agent hides those apps'
 * tools for the run and the threads it starts. It can only take apps away: what the
 * Connectors page allows still decides everything else.
 */

const key = (scope: string) => `locus:connectors-off:${scope}`;

/** The apps turned off for this sub-account's chat; none when the browser keeps nothing. */
export function readConnectorsOff(scope: string): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(key(scope)) ?? "[]");
    return Array.isArray(stored) ? stored.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Turns one app on or off for this sub-account's chat; the new list. */
export function setConnectorOff(scope: string, toolkit: string, off: boolean): string[] {
  const now = new Set(readConnectorsOff(scope));
  if (off) now.add(toolkit);
  else now.delete(toolkit);
  const list = [...now];
  try {
    if (list.length > 0) window.localStorage.setItem(key(scope), JSON.stringify(list));
    else window.localStorage.removeItem(key(scope));
  } catch {
    // Private windows and full storage: the switch holds for this page only.
  }
  return list;
}
