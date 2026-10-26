import type { PendingEdit } from "./use-visual-edits";

/** Unsaved changes, one per element and attribute (see `keyOf`). */
export type Pending = Map<string, PendingEdit>;

/**
 * One pending change per element and attribute. Text is per copy as well: an element in a list
 * renders once per item, each with its own text (and its own place in the data), so two copies'
 * text changes stay two changes, told apart by the text each copy started with.
 */
export const keyOf = (edit: PendingEdit) =>
  edit.kind === "text"
    ? `${edit.target}|text|${edit.from}`
    : `${edit.target}|${edit.kind}|${edit.kind === "attr" ? edit.name : ""}`;

/** Whether an edit would change nothing (it was set back to what it was). */
const unchanged = (edit: PendingEdit) =>
  edit.kind === "newTab" ? edit.on === edit.from : edit.to === (edit.from ?? "");

/** The unsaved changes with `edit` added, and the key it was kept under. */
export function withEdit(current: Pending, edit: PendingEdit): { next: Pending; key: string } {
  const next = new Map(current);
  // A second change to text already changed continues that change: keep what the element had
  // first, so the save can check it hasn't changed since.
  const chained =
    edit.kind === "text"
      ? [...next.entries()].find(
          ([, e]) => e.kind === "text" && e.target === edit.target && e.to === edit.from,
        )
      : undefined;
  const key = chained ? chained[0] : keyOf(edit);
  const earlier = next.get(key);
  const merged = earlier ? ({ ...edit, from: earlier.from } as PendingEdit) : edit;
  if (unchanged(merged)) next.delete(key);
  else next.set(key, merged);
  return { next, key };
}

/** Steps of the same field this close together (typing) undo as one. */
const TYPING_MS = 1_000;
const MAX_STEPS = 100;

/**
 * Undo and redo over the unsaved changes. Each step is the whole set of changes before it, so
 * undoing is going back to that set; quick changes to one field (typing) are one step.
 */
export class EditHistory {
  private past: Pending[] = [];
  private future: Pending[] = [];
  private last: { key: string; at: number } | null = null;

  /** Notes that `before` is about to become something else because of a change to `key`. */
  step(before: Pending, key: string, now = Date.now()): void {
    const typing = this.last && this.last.key === key && now - this.last.at < TYPING_MS;
    if (!typing) {
      this.past.push(before);
      if (this.past.length > MAX_STEPS) this.past.shift();
    }
    this.future = [];
    this.last = { key, at: now };
  }

  undo(current: Pending): Pending | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(current);
    this.last = null;
    return previous;
  }

  redo(current: Pending): Pending | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    this.last = null;
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.last = null;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}

/**
 * What the page has to show to go from `from` to `to`: each change that is new or different,
 * and for each one that went away, its element's value from before it.
 */
export function differences(from: Pending, to: Pending): PendingEdit[] {
  const out: PendingEdit[] = [];
  for (const [key, edit] of to) if (from.get(key) !== edit) out.push(edit);
  for (const [key, edit] of from) {
    if (to.has(key)) continue;
    if (edit.kind === "text") {
      // The page shows `edit.to`; put back what the copy had.
      out.push({ kind: "text", target: edit.target, from: edit.to, to: edit.from });
    } else if (edit.kind === "newTab") {
      out.push({ ...edit, from: edit.on, on: edit.from });
    } else {
      out.push({ ...edit, from: edit.to, to: edit.from ?? "" });
    }
  }
  return out;
}

const KINDS = new Set(["text", "attr", "newTab"]);
const NAMES = new Set(["src", "alt", "href", "className", "placeholder"]);

/** Unsaved changes kept in the browser tab, read back with every field checked. */
export function readStored(raw: string | null): Pending {
  const out: Pending = new Map();
  if (!raw) return out;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(list)) return out;
  for (const item of list.slice(0, 500)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.target !== "string" || !KINDS.has(e.kind as string)) continue;
    if (e.kind === "text" && typeof e.from === "string" && typeof e.to === "string") {
      const edit: PendingEdit = { kind: "text", target: e.target, from: e.from, to: e.to };
      out.set(keyOf(edit), edit);
    } else if (
      e.kind === "attr" &&
      NAMES.has(e.name as string) &&
      (typeof e.from === "string" || e.from === null) &&
      typeof e.to === "string"
    ) {
      const edit = {
        kind: "attr",
        target: e.target,
        name: e.name,
        from: e.from,
        to: e.to,
      } as PendingEdit;
      out.set(keyOf(edit), edit);
    } else if (e.kind === "newTab" && typeof e.from === "boolean" && typeof e.on === "boolean") {
      const edit: PendingEdit = { kind: "newTab", target: e.target, from: e.from, on: e.on };
      out.set(keyOf(edit), edit);
    }
  }
  return out;
}
