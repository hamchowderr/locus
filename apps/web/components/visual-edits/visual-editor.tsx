"use client";

import { MousePointerClick, Save, Sparkles, Undo2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAgentControllerChat } from "@/lib/agent-controller/use-agent-controller-chat";
import { cn } from "@/lib/utils";
import { chooseSiteForChat } from "../../app/sites/[siteId]/visual-edits-actions";
import { currentOf, groupsFor, type StyleGroup, setGroup } from "./classes";
import {
  type PendingEdit,
  type SaveResult,
  type SelectedItem,
  useVisualEdits,
} from "./use-visual-edits";

const field = "w-full rounded-md border border-neutral-300 px-2 py-1 text-sm";

/**
 * Visual edits for a site's preview, like HighLevel's: turn it on, click anything on the page
 * to select it (Shift-click for more), double-click text to type over it, or change it in this
 * panel. Changes show in the preview at once and cost nothing; Save keeps them as a new
 * version, Discard throws them away. "Ask the site builder" sends the selection and a request
 * to the chat's site builder, which uses AI credits.
 */
export function VisualEditor({
  siteId,
  frame,
  previewUrl,
  chatMode,
  editable,
  onSaved,
  className,
}: {
  siteId: string;
  frame: HTMLIFrameElement | null;
  previewUrl: string | null;
  /** The chat's site-builder mode id. */
  chatMode: string;
  /** False when the preview shows an older version, which can't be edited in place. */
  editable: boolean;
  onSaved?: (result: SaveResult) => void;
  className?: string;
}) {
  const edits = useVisualEdits({ siteId, frame, previewUrl, onSaved });
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const count = edits.pending.length;

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
          {edits.enabled ? "Selecting" : "Select items"}
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
          Turn on <strong>Select items</strong>, then click anything on the page to change it.
          Double-click text to type over it. Changes made here are free and don't use AI.
        </p>
      ) : edits.selection.length === 0 ? (
        <p className="text-neutral-600">
          Click an item on the page. Shift-click to select more than one.
        </p>
      ) : edits.selection.length === 1 && edits.selection[0] ? (
        <ItemControls item={edits.selection[0]} theme={edits.theme} onChange={edits.change} />
      ) : (
        <p className="text-neutral-600">
          {edits.selection.length} items selected. Describe a change for all of them below.
        </p>
      )}

      {editable && edits.enabled && edits.selection.length > 0 && (
        <>
          <Separator />
          <AskBuilder
            siteId={siteId}
            chatMode={chatMode}
            selection={edits.selection}
            page={edits.path}
            unsaved={count > 0}
            onChanged={edits.reload}
          />
        </>
      )}

      {(count > 0 || edits.problem || edits.failures.length > 0 || saved) && <Separator />}
      {count > 0 && (
        <div className="flex flex-col gap-2">
          <p>{count === 1 ? "1 change" : `${count} changes`} not saved yet.</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={edits.saving}
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
              disabled={edits.saving}
              onClick={edits.discard}
            >
              <Undo2 data-icon="inline-start" />
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
  onChange,
}: {
  item: SelectedItem;
  theme: Record<string, string>;
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
            key={item.target}
            className={field}
            rows={3}
            defaultValue={item.text}
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
            key={`${item.target}-src`}
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
            key={`${item.target}-alt`}
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
              key={`${item.target}-href`}
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
            key={`${item.target}-ph`}
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

/** Sends the selection and a request to the chat's site builder (uses AI credits). */
function AskBuilder({
  siteId,
  chatMode,
  selection,
  page,
  unsaved,
  onChanged,
}: {
  siteId: string;
  chatMode: string;
  selection: SelectedItem[];
  page: string;
  /** Unsaved visual edits: the builder works on saved files, so they go first. */
  unsaved: boolean;
  onChanged: () => void;
}) {
  const [request, setRequest] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const changed = useRef(false);
  const chat = useAgentControllerChat({
    onToolEnd: (tool) => {
      if (!tool.isError && ["files", "versions", "add_dependency"].includes(tool.toolName)) {
        changed.current = true;
      }
    },
  });
  const busy = chat.status === "streaming";

  // When the builder's turn ends after changing files, show the result in the preview.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && changed.current) {
      changed.current = false;
      onChanged();
    }
    wasBusy.current = busy;
  }, [busy, onChanged]);

  const last = [...chat.transcript.messages].reverse().find((m) => m.role === "assistant");
  const answer = last?.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  const waiting = chat.transcript.pendingSuspension || chat.transcript.pendingApproval;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const text = request.trim();
        if (!text || busy || unsaved) return;
        setProblem(null);
        const chosen = await chooseSiteForChat(siteId);
        if ("problem" in chosen) {
          setProblem(chosen.problem);
          return;
        }
        const sent = await chat.sendMessage(
          `${describeSelection(selection, page)}\n\nPlease change ${selection.length === 1 ? "it" : "them"}: ${text}`,
          { mode: chatMode },
        );
        if (sent) setRequest("");
        else setProblem(chat.transcript.error ?? "The site builder couldn't be reached.");
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
              : "e.g. Make these buttons match"
          }
          onChange={(e) => setRequest(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={busy || unsaved || !request.trim()}
        >
          <Sparkles data-icon="inline-start" />
          {busy ? "Working" : "Ask"}
        </Button>
        <span className="text-xs text-neutral-500">
          {unsaved ? "Save or discard your changes first" : "Uses AI credits"}
        </span>
      </div>
      {problem && <p className="text-red-700">{problem}</p>}
      {waiting && (
        <p className="text-neutral-600">
          The site builder needs an answer from you.{" "}
          <Link href="/chat" className="underline">
            Open the chat
          </Link>
        </p>
      )}
      {answer && !busy && <p className="whitespace-pre-wrap text-neutral-700">{answer}</p>}
    </form>
  );
}
