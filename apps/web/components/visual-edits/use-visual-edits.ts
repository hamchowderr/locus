"use client";

import { VISUAL_EDITS_MESSAGE } from "@locus/studio/visual-edits-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { differences, EditHistory, type Pending, readStored, sameAt, withEdit } from "./history";

/** What the preview reports about one selected element. */
export interface SelectedItem {
  /** Where the element is in the site's source, `path:offset`. */
  target: string;
  tag: string;
  /** Its text when it holds only text, else null. */
  text: string | null;
  className: string;
  src: string | null;
  alt: string | null;
  href: string | null;
  newTab: boolean | null;
  placeholder: string | null;
  inLink: boolean;
}

/** One unsaved change; `from` is what the element had before any change in this session. */
export type PendingEdit =
  | { kind: "text"; target: string; from: string; to: string }
  | {
      kind: "attr";
      target: string;
      name: "src" | "alt" | "href" | "className" | "placeholder";
      from: string | null;
      to: string;
    }
  | { kind: "newTab"; target: string; from: boolean; on: boolean };

export interface SaveResult {
  version: number | null;
  applied: number;
  failed: { index: number; reason: string }[];
  publishError?: string;
  /** The draft's fingerprint after the save. */
  draft: string;
}

const MAX_TEXT = 10_000;
const str = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === "string" ? v.slice(0, max) : null;

/** A selected item as the page reported it, with every field checked: the page is untrusted. */
function readItem(raw: unknown): SelectedItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const target = str(r.target, 600);
  if (!target || !/^[^:"]+:\d+$/.test(target)) return null;
  return {
    target,
    tag: (str(r.tag, 40) ?? "div").toLowerCase().replace(/[^a-z0-9-]/g, ""),
    text: str(r.text),
    className: str(r.className, 4_000) ?? "",
    src: str(r.src, 4_000),
    alt: str(r.alt, 4_000),
    href: str(r.href, 4_000),
    newTab: typeof r.newTab === "boolean" ? r.newTab : null,
    placeholder: str(r.placeholder, 4_000),
    inLink: r.inLink === true,
  };
}

/** Only plain colour values from the page's theme reach a style. */
const COLOR =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\([0-9a-z.,%\s/+-]*\))$/i;

/** Where a site's unsaved changes wait in this browser tab, so closing the panel keeps them. */
const storageKey = (siteId: string) => `locus:visual-edits:${siteId}`;

function loadStored(siteId: string): Pending {
  try {
    return readStored(window.sessionStorage.getItem(storageKey(siteId)));
  } catch {
    return new Map();
  }
}

/** How many changes to a site wait unsaved in this browser tab. */
export function storedCount(siteId: string): number {
  return typeof window === "undefined" ? 0 : loadStored(siteId).size;
}

function store(siteId: string, pending: Pending) {
  try {
    if (pending.size === 0) window.sessionStorage.removeItem(storageKey(siteId));
    else window.sessionStorage.setItem(storageKey(siteId), JSON.stringify([...pending.values()]));
  } catch {
    // Storage can be off (a private window); the changes still live while the page is open.
  }
}

/**
 * Talks to the visual-edits script inside a site's preview frame: turns select mode on and
 * off, receives what was clicked or typed, shows unsaved changes in the page and saves them.
 * Messages are only accepted from the frame's own window at the preview's origin, and only
 * sent to that origin.
 */
export function useVisualEdits({
  siteId,
  frame,
  previewUrl,
  onSaved,
}: {
  siteId: string;
  frame: HTMLIFrameElement | null;
  previewUrl: string | null;
  onSaved?: ((result: SaveResult) => void) | undefined;
}) {
  const origin = previewUrl ? new URL(previewUrl).origin : null;
  const [ready, setReady] = useState(false);
  const [path, setPath] = useState("/");
  const [theme, setTheme] = useState<Record<string, string>>({});
  // Opening Visual edits starts selecting at once, as in HighLevel's editor.
  const [enabled, setEnabled] = useState(true);
  const [selection, setSelection] = useState<SelectedItem[]>([]);
  // Changes not saved when the panel was closed (or the page reloaded) come back.
  const [pending, setPending] = useState<Pending>(() => loadStored(siteId));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const history = useRef(new EditHistory()).current;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  /** The draft the preview's page was made from, as its script reported it. */
  const draftRef = useRef("");
  const savingRef = useRef(false);
  /** Goes up on every undo and redo, so the panel's fields show the value they went back to. */
  const [generation, setGeneration] = useState(0);

  const send = useCallback(
    (message: Record<string, unknown>) => {
      if (!frame?.contentWindow || !origin) return;
      frame.contentWindow.postMessage({ ...message, source: VISUAL_EDITS_MESSAGE }, origin);
    },
    [frame, origin],
  );

  /** Makes `next` the unsaved changes (the ref first, so changes in one event chain). */
  const commit = useCallback(
    (next: Pending) => {
      pendingRef.current = next;
      setPending(next);
      store(siteId, next);
    },
    [siteId],
  );

  const record = useCallback(
    (edit: PendingEdit) => {
      const before = pendingRef.current;
      const { next, key } = withEdit(before, edit);
      if (sameAt(before, next, key)) return;
      history.step(before, key);
      commit(next);
      setFailures([]);
    },
    [commit, history],
  );

  /** Goes back (or forward) to another set of unsaved changes and shows it in the page. */
  const travel = useCallback(
    (direction: "undo" | "redo") => {
      // The save is sending these changes: going back now would change what it saves.
      if (savingRef.current) return;
      const current = pendingRef.current;
      const to = direction === "undo" ? history.undo(current) : history.redo(current);
      if (!to) return;
      const changed = differences(current, to);
      commit(to);
      setFailures([]);
      for (const edit of changed) send({ type: "show", change: shown(edit) });
      // A text change is one copy's (the one showing its old text); attributes are every copy's.
      setSelection((items) =>
        items.map((item) =>
          changed.reduce(
            (it, edit) =>
              edit.target === it.target && (edit.kind !== "text" || it.text === edit.from)
                ? applied(it, edit)
                : it,
            item,
          ),
        ),
      );
      setGeneration((n) => n + 1);
    },
    [commit, history, send],
  );
  const undo = useCallback(() => travel("undo"), [travel]);
  const redo = useCallback(() => travel("redo"), [travel]);

  // The page's script announces itself when it loads (again on every reload); the editor
  // answers with hello, the script replies ready, and the editor puts it back in its mode.
  useEffect(() => {
    if (!frame || !origin) return;
    const greet = () => send({ type: "hello" });
    const onLoad = () => {
      setReady(false);
      greet();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      const data = event.data as { source?: unknown; type?: unknown } & Record<string, unknown>;
      if (!data || data.source !== VISUAL_EDITS_MESSAGE) return;
      if (data.type === "announce") {
        greet();
      } else if (data.type === "ready") {
        setReady(true);
        if (typeof data.path === "string") setPath(data.path);
        if (typeof data.draft === "string") draftRef.current = data.draft.slice(0, 128);
        if (data.theme && typeof data.theme === "object") {
          setTheme(
            Object.fromEntries(
              Object.entries(data.theme as Record<string, unknown>).filter(
                (e): e is [string, string] => typeof e[1] === "string" && COLOR.test(e[1].trim()),
              ),
            ),
          );
        }
        if (enabledRef.current) send({ type: "enable" });
        // Changes not saved yet are shown again on the reloaded page.
        for (const edit of pendingRef.current.values()) send({ type: "show", change: shown(edit) });
      } else if (data.type === "selection" && Array.isArray(data.items)) {
        setSelection(
          (data.items as unknown[])
            .slice(0, 50)
            .map(readItem)
            .filter((i): i is SelectedItem => i !== null),
        );
      } else if (data.type === "text" && typeof data.target === "string") {
        const from = str(data.from);
        const to = str(data.to);
        if (from !== null && to !== null) record({ kind: "text", target: data.target, from, to });
      } else if (data.type === "undo" || data.type === "redo") {
        // Ctrl+Z pressed while the page had the keyboard.
        travel(data.type);
      }
    };
    window.addEventListener("message", onMessage);
    frame.addEventListener("load", onLoad);
    // Already showing the site (another origin, so no document to read): say hello now.
    if (frame.contentDocument === null) greet();
    return () => {
      window.removeEventListener("message", onMessage);
      frame.removeEventListener("load", onLoad);
    };
  }, [frame, origin, send, record, travel]);

  // Closing the panel puts the page back to normal: links and buttons work again.
  useEffect(() => () => send({ type: "disable" }), [send]);

  // Ctrl+Z / Cmd+Z undoes, Shift+Ctrl+Z or Ctrl+Y redoes, unless a field has the keyboard
  // (it undoes its own typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = undoKey(e);
      if (!key) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      travel(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [travel]);

  /** Records a change made in the panel and shows it in the page right away. */
  const change = useCallback(
    (edit: PendingEdit) => {
      record(edit);
      send({ type: "show", change: shown(edit) });
      setSelection((items) =>
        items.map((item) => (item.target === edit.target ? applied(item, edit) : item)),
      );
    },
    [record, send],
  );

  const setMode = useCallback(
    (on: boolean) => {
      setEnabled(on);
      send({ type: on ? "enable" : "disable" });
      if (!on) setSelection([]);
    },
    [send],
  );

  const reload = useCallback(() => {
    // Setting the attribute again reloads the frame, even to the same address.
    frame?.setAttribute("src", frame.getAttribute("src") ?? "");
  }, [frame]);

  const discard = useCallback(() => {
    commit(new Map());
    history.clear();
    setSelection([]);
    setFailures([]);
    reload();
  }, [commit, history, reload]);

  /** Saves every unsaved change as a new version; null when it couldn't. */
  const save = useCallback(async (): Promise<SaveResult | null> => {
    const sent = [...pendingRef.current.entries()];
    const edits = sent.map(([, edit]) => toRequest(edit));
    if (edits.length === 0) return null;
    savingRef.current = true;
    setSaving(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/visual-edits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edits, draft: draftRef.current }),
      });
      const body = (await response.json().catch(() => null)) as
        | (SaveResult & { error?: string })
        | null;
      if (!response.ok || !body) {
        setProblem(body?.error ?? "The changes couldn't be saved. Try again.");
        return null;
      }
      setFailures(body.failed.map((f) => f.reason));
      if (typeof body.draft === "string") draftRef.current = body.draft;
      // What wasn't saved stays pending (still shown in the page), to fix or discard, and so
      // does anything changed while the save was on its way.
      const failed = new Set(body.failed.map((f) => f.index));
      const next = new Map(pendingRef.current);
      sent.forEach(([key, edit], i) => {
        if (!failed.has(i) && next.get(key) === edit) next.delete(key);
      });
      commit(next);
      // Saved changes are in the site's files now: undoing them is a change of its own.
      history.clear();
      send({ type: "clear" });
      onSaved?.(body);
      return body;
    } catch {
      setProblem("The changes couldn't be saved. Check your connection and try again.");
      return null;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [siteId, onSaved, send, commit, history]);

  return {
    ready,
    /** The page the preview is showing, e.g. "/services". */
    path,
    /** The site's theme colours as CSS values, by name (e.g. primary). */
    theme,
    enabled,
    setMode,
    selection,
    clearSelection: () => send({ type: "clear" }),
    pending: [...pending.values()],
    change,
    save,
    discard,
    reload,
    undo,
    redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    generation,
    saving,
    problem,
    failures,
  };
}

/** Whether a key press is undo or redo. */
export function undoKey(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): "undo" | "redo" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  // Ctrl+Y only: Cmd+Y is the browser's history on a Mac.
  if (key === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey) return "redo";
  return null;
}

/** Asks before the page is left while a site has unsaved changes. */
export function useLeaveWarning(unsaved: boolean) {
  useEffect(() => {
    if (!unsaved) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [unsaved]);
}

/** How the page shows an unsaved change. */
function shown(edit: PendingEdit) {
  if (edit.kind === "text") {
    return { kind: "text", target: edit.target, from: edit.from, value: edit.to };
  }
  if (edit.kind === "newTab") {
    return { kind: "attr", target: edit.target, name: "newTab", value: edit.on };
  }
  return { kind: "attr", target: edit.target, name: edit.name, value: edit.to };
}

function applied(item: SelectedItem, edit: PendingEdit): SelectedItem {
  if (edit.kind === "text") return { ...item, text: edit.to };
  if (edit.kind === "newTab") return { ...item, newTab: edit.on };
  return { ...item, [edit.name]: edit.to };
}

/** The request body's form of an edit (see `VisualEdit` in `@locus/studio`). */
function toRequest(edit: PendingEdit) {
  return edit;
}
