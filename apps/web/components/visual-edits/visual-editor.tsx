"use client";

import { MousePointerClick, Redo2, Save, Sparkles, Trash2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { currentOf, groupsFor, type StyleGroup, setGroup } from "./classes";
import {
  type PendingEdit,
  type SaveResult,
  type SelectedItem,
  useVisualEdits,
} from "./use-visual-edits";

const field = "w-full rounded-md border border-neutral-300 px-2 py-1 text-sm";

/**
 * Visual edits for a site's preview, like HighLevel's: open it and click anything on the page
 * to select it (Shift-click for more), double-click text to type over it, or change it in this
 * panel. Changes show in the preview at once and cost nothing; Ctrl+Z undoes them, Save keeps
 * them as a new version, Discard throws them away. They survive closing the panel until then. "Ask the site builder" sends the selection and a request
 * to the site's chat beside the preview, which uses AI credits.
 */
export function VisualEditor({
  siteId,
  frame,
  previewUrl,
  ask,
  asking: chatBusy,
  editable,
  onSaved,
  onPendingChange,
  className,
}: {
  siteId: string;
  frame: HTMLIFrameElement | null;
  previewUrl: string | null;
  /** Sends a request to the site's chat; false when it wasn't sent. */
  ask: (text: string) => Promise<boolean>;
  /** The site's chat is working on a turn. */
  asking: boolean;
  /** False when the preview shows an older version, which can't be edited in place. */
  editable: boolean;
  onSaved?: (result: SaveResult) => void;
  /** How many changes aren't saved yet, whenever that changes. */
  onPendingChange?: (count: number) => void;
  className?: string;
}) {
  const edits = useVisualEdits({ siteId, frame, previewUrl, onSaved });
  const [saved, setSaved] = useState<SaveResult | null>(null);
  // Once something has been selected the chat box stays, so its answer and conversation
  // survive the selection being cleared (Escape, a reload after the builder's change).
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (edits.selection.length > 0) setAsking(true);
  }, [edits.selection.length]);
  const count = edits.pending.length;
  useEffect(() => onPendingChange?.(count), [count, onPendingChange]);

  return (
    <aside className={cn("flex w-80 shrink-0 flex-col gap-3 overflow-y-auto text-sm", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Visual edits</h2>
        <Button
          type="button"
          size="sm"
          variant={edits.enabled ? "default" : "outline"}
          aria-pressed={edits.enabled}
          disabled={!editable || !edits.ready}
          onClick={() => edits.setMode(!edits.enabled)}
        >
          <MousePointerClick data-icon="inline-start" />
          {edits.enabled ? "Selecting" : "Select"}
        </Button>
      </div>
      {!editable ? (
        <p className="text-neutral-600">
          This preview shows an older version. Visual edits change the current site: open the
          current preview to use them.
        </p>
      ) : !edits.ready ? (
        <p className="text-neutral-600">Visual edits start once the preview has loaded.</p>
      ) : !edits.enabled ? (
        <p className="text-neutral-600">
          The page works as usual, so you can follow links and open menus. Turn on{" "}
          <strong>Select</strong> to change items again.
        </p>
      ) : edits.selection.length === 0 ? (
        <p className="text-neutral-600">
          Click anything on the page to change it, or double-click text to type over it. Shift-click
          selects more than one. Changes made here are free and don't use AI.
        </p>
      ) : edits.selection.length === 1 && edits.selection[0] ? (
        <ItemControls
          item={edits.selection[0]}
          theme={edits.theme}
          generation={edits.generation}
          onChange={edits.change}
        />
      ) : (
        <p className="text-neutral-600">
          {edits.selection.length} items selected. Describe a change for all of them below.
        </p>
      )}

      {editable && edits.ready && asking && (
        <>
          <Separator />
          <AskBuilder
            ask={ask}
            busy={chatBusy}
            selection={edits.selection}
            page={edits.path}
            unsaved={count > 0}
          />
        </>
      )}

      {(count > 0 || edits.problem || edits.failures.length > 0 || saved) && <Separator />}
      {(count > 0 || edits.canUndo || edits.canRedo) && (
        <div className="flex flex-col gap-2">
          <p>
            {count === 0
              ? "No changes waiting to be saved."
              : `${count === 1 ? "1 change" : `${count} changes`} not saved yet.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
              disabled={edits.saving || !edits.canUndo}
              onClick={edits.undo}
            >
              <Undo2 />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo"
              disabled={edits.saving || !edits.canRedo}
              onClick={edits.redo}
            >
              <Redo2 />
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={edits.saving || count === 0}
              onClick={async () => {
                setSaved(null);
                setSaved(await edits.save());
              }}
            >
              <Save data-icon="inline-start" />
              {edits.saving ? "Saving" : "Save"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={edits.saving || count === 0}
              onClick={edits.discard}
            >
              <Trash2 data-icon="inline-start" />
              Discard
            </Button>
          </div>
        </div>
      )}
      {edits.problem && <p className="text-red-700">{edits.problem}</p>}
      <SaveSummary failures={edits.failures} />
      {saved?.version != null && (
        <p className="text-neutral-600">
          Saved as version {saved.version}.{saved.publishError ? ` ${saved.publishError}` : ""}
        </p>
      )}
    </aside>
  );
}

function SaveSummary({ failures }: { failures: string[] }) {
  if (failures.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
      <p className="font-medium">
        {failures.length === 1
          ? "One change wasn't saved:"
          : `${failures.length} changes weren't saved:`}
      </p>
      <ul className="mt-1 list-disc pl-4">
        {[...new Set(failures)].map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}

const tagName = (item: SelectedItem) =>
  ({
    a: "Link",
    button: "Button",
    img: "Image",
    h1: "Heading",
    h2: "Heading",
    h3: "Heading",
    h4: "Heading",
    p: "Paragraph",
    li: "List item",
    section: "Section",
    header: "Header",
    footer: "Footer",
    nav: "Menu",
    input: "Field",
    textarea: "Field",
  })[item.tag] ?? (item.text !== null ? "Text" : "Box");

/** The controls for one selected item: only what fits it, like HighLevel's panel. */
function ItemControls({
  item,
  theme,
  generation,
  onChange,
}: {
  item: SelectedItem;
  theme: Record<string, string>;
  /** Changes on undo and redo, so the fields below start again from the item's value. */
  generation: number;
  onChange: (edit: PendingEdit) => void;
}) {
  const attr = (name: "src" | "alt" | "href" | "className" | "placeholder", to: string) =>
    onChange({ kind: "attr", target: item.target, name, from: item[name], to });

  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium">{tagName(item)}</p>
      {item.text !== null && (
        <Labeled label="Text">
          <textarea
            className={field}
            rows={3}
            value={item.text}
            onChange={(e) =>
              onChange({
                kind: "text",
                target: item.target,
                from: item.text ?? "",
                to: e.target.value,
              })
            }
          />
        </Labeled>
      )}
      {item.src !== null && (
        <Labeled label="Image link">
          <input
            key={`${item.target}-src-${generation}`}
            className={field}
            defaultValue={item.src}
            placeholder="https://"
            onBlur={(e) => e.target.value !== item.src && attr("src", e.target.value.trim())}
          />
        </Labeled>
      )}
      {item.alt !== null && (
        <Labeled label="Describe the image (for screen readers and search)">
          <input
            key={`${item.target}-alt-${generation}`}
            className={field}
            defaultValue={item.alt}
            onChange={(e) => attr("alt", e.target.value)}
          />
        </Labeled>
      )}
      {item.href !== null && (
        <>
          <Labeled label="Link goes to">
            <input
              key={`${item.target}-href-${generation}`}
              className={field}
              defaultValue={item.href}
              placeholder="/contact or https://"
              onBlur={(e) => e.target.value !== item.href && attr("href", e.target.value.trim())}
            />
          </Labeled>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={item.newTab === true}
              onChange={(e) =>
                onChange({
                  kind: "newTab",
                  target: item.target,
                  from: item.newTab === true,
                  on: e.target.checked,
                })
              }
            />
            Open in a new tab
          </label>
        </>
      )}
      {item.placeholder !== null && (
        <Labeled label="Hint shown in the empty field">
          <input
            key={`${item.target}-ph-${generation}`}
            className={field}
            defaultValue={item.placeholder}
            onChange={(e) => attr("placeholder", e.target.value)}
          />
        </Labeled>
      )}
      <Separator />
      <p className="font-medium">Style</p>
      {groupsFor(item).map((group) => (
        <StyleControl
          key={group.id}
          group={group}
          className={item.className}
          theme={theme}
          onChange={(next) => attr("className", next)}
        />
      ))}
      <p className="text-xs text-neutral-500">
        Some new styles only show once you save, while the preview updates.
      </p>
    </div>
  );
}

function StyleControl({
  group,
  className,
  theme,
  onChange,
}: {
  group: StyleGroup;
  className: string;
  theme: Record<string, string>;
  onChange: (className: string) => void;
}) {
  const value = currentOf(className, group);
  const known = group.options.some((o) => o.value === value);
  const color = group.id === "text-color" || group.id === "background";
  if (color) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-neutral-600">{group.label}</span>
        <div className="flex flex-wrap gap-1">
          {group.options.map((option) => (
            <button
              key={option.value || "none"}
              type="button"
              title={option.label}
              aria-label={`${group.label}: ${option.label}`}
              aria-pressed={option.value === value}
              onClick={() => onChange(setGroup(className, group, option.value))}
              className={cn(
                "size-6 rounded border border-neutral-300",
                option.value === value && "ring-2 ring-blue-600 ring-offset-1",
              )}
              style={{ background: theme[option.label] ?? swatch(option.label) }}
            />
          ))}
        </div>
      </div>
    );
  }
  return (
    <Labeled label={group.label}>
      <select
        className={field}
        value={value}
        onChange={(e) => onChange(setGroup(className, group, e.target.value))}
      >
        {!known && <option value={value}>{value || "default"}</option>}
        {group.options.map((option) => (
          <option key={option.value || "none"} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Labeled>
  );
}

/** A fixed colour's swatch; theme colours come from the preview, with neutrals until then. */
function swatch(label: string): string {
  const fixed: Record<string, string> = {
    white: "#fff",
    black: "#000",
    "slate-900": "#0f172a",
    "slate-500": "#64748b",
    "red-600": "#dc2626",
    "orange-500": "#f97316",
    "amber-400": "#fbbf24",
    "green-600": "#16a34a",
    "teal-600": "#0d9488",
    "sky-500": "#0ea5e9",
    "blue-600": "#2563eb",
    "indigo-600": "#4f46e5",
    "purple-600": "#9333ea",
    "pink-600": "#db2777",
    none: "repeating-linear-gradient(45deg,#fff,#fff 4px,#e5e5e5 4px,#e5e5e5 8px)",
  };
  return (
    fixed[label] ??
    (label.endsWith("foreground") ? "#525252" : label === "background" ? "#fafafa" : "#a3a3a3")
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: `children` is always the field itself
    <label className="flex flex-col gap-1">
      <span className="text-neutral-600">{label}</span>
      {children}
    </label>
  );
}

/** What the site builder is told about each selected item. */
export function describeSelection(items: SelectedItem[], page: string): string {
  const lines = items.map((item) => {
    const [path, offset] = [
      item.target.slice(0, item.target.lastIndexOf(":")),
      item.target.slice(item.target.lastIndexOf(":") + 1),
    ];
    const bits = [`<${item.tag}> in ${path} (the JSX element starting at character ${offset})`];
    if (item.text) bits.push(`text "${item.text.trim().slice(0, 200)}"`);
    if (item.src) bits.push(`image ${item.src}`);
    if (item.href) bits.push(`link to ${item.href}`);
    if (item.className) bits.push(`classes "${item.className.slice(0, 300)}"`);
    return `- ${bits.join(", ")}`;
  });
  return `On the ${page === "/" ? "home" : page} page, I selected:\n${lines.join("\n")}`;
}

/** Sends the selection and a request to the site's chat (uses AI credits). */
function AskBuilder({
  ask,
  busy,
  selection,
  page,
  unsaved,
}: {
  ask: (text: string) => Promise<boolean>;
  busy: boolean;
  selection: SelectedItem[];
  page: string;
  /** Unsaved visual edits: the builder works on saved files, so they go first. */
  unsaved: boolean;
}) {
  const [request, setRequest] = useState("");

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const text = request.trim();
        if (!text || busy || unsaved || selection.length === 0) return;
        const sent = await ask(
          `${describeSelection(selection, page)}\n\nPlease change ${selection.length === 1 ? "it" : "them"}: ${text}`,
        );
        if (sent) setRequest("");
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="font-medium">Ask the site builder</span>
        <textarea
          className={field}
          rows={3}
          value={request}
          placeholder={
            selection.length === 1
              ? "e.g. Make this stand out more"
              : "e.g. Make these match each other"
          }
          onChange={(e) => setRequest(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={busy || unsaved || selection.length === 0 || !request.trim()}
        >
          <Sparkles data-icon="inline-start" />
          {busy ? "Working" : "Ask"}
        </Button>
        <span className="text-xs text-neutral-500">
          {unsaved
            ? "Save or discard your changes first"
            : selection.length === 0
              ? "Select items to ask about"
              : "The answer shows in the chat"}
        </span>
      </div>
    </form>
  );
}
