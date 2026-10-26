import { createHash } from "node:crypto";
import { parse } from "@babel/parser";
import { PREVIEW_DEV_HOSTS, withPreviewDevHosts } from "./preview-config.ts";
import { withPreviewAuth } from "./templates/backend.ts";
import { annotateSource, isAnnotatable } from "./visual-edits.ts";
import { SOURCE_ATTR, VISUAL_EDITS_MESSAGE } from "./visual-edits-protocol.ts";
import type { SiteFile } from "./workspace.ts";

/** Where the preview serves the visual-edits script from. Only the preview has it. */
export const VISUAL_EDITS_SCRIPT_PATH = "public/__locus/visual-edits.js";
const SCRIPT_URL = "/__locus/visual-edits.js";

export { VISUAL_EDITS_MESSAGE } from "./visual-edits-protocol.ts";

/**
 * A fingerprint of the draft's files. The preview's script carries the one it was made from
 * and the editor sends it with a save, so an edit is never placed by offsets taken from a
 * page the draft has moved on from.
 */
export function draftFingerprint(files: SiteFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path).update("\0");
    hash.update(
      typeof file.content === "string" ? Buffer.from(file.content, "utf8") : file.content,
    );
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * What the sandbox runs for the live preview: the draft, plus what visual edits need. Every
 * page and component is annotated (`annotateSource`), `app/layout.tsx` loads the script, and
 * the script itself is added under `public/__locus/`. The draft itself is never changed.
 * A draft file at the script's path is replaced: the preview's copy must be Locus's own.
 * Its `next.config` also lets the preview's host use the dev server (`withPreviewDevHosts`).
 */
export function previewFiles(
  files: SiteFile[],
  options: {
    /**
     * The Locus web app's origins: the only pages the script takes orders from or reports to.
     * With none, the script is still added but never answers anyone.
     */
    editorOrigins?: string[];
    /** Hosts the preview is opened on (`PREVIEW_DEV_HOSTS` unless given). */
    devHosts?: string[];
  } = {},
): SiteFile[] {
  let loadsScript = false;
  const out = files
    .filter((file) => file.path !== VISUAL_EDITS_SCRIPT_PATH)
    .map((file) => {
      if (typeof file.content !== "string" || !isAnnotatable(file.path)) return file;
      let content = annotateSource(file.path, file.content);
      if (file.path === "app/layout.tsx") {
        content = withScriptTag(content);
        loadsScript = content.includes(`src="${SCRIPT_URL}"`);
      }
      return content === file.content ? file : { path: file.path, content };
    });
  // Only a layout that loads it needs the script (a draft without one has nothing to edit).
  if (loadsScript) {
    out.push({
      path: VISUAL_EDITS_SCRIPT_PATH,
      content: visualEditsScript(options.editorOrigins ?? [], draftFingerprint(files)),
    });
  }
  return withPreviewDevHosts(withPreviewAuth(out), options.devHosts ?? PREVIEW_DEV_HOSTS);
}

/** The layout with `<script src="/__locus/visual-edits.js" async />` at the end of `<body>`. */
function withScriptTag(code: string): string {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch {
    return code;
  }
  let at = -1;
  const visit = (node: unknown): void => {
    if (at >= 0 || typeof node !== "object" || node === null) return;
    const n = node as {
      type?: string;
      openingElement?: { name?: { type?: string; name?: string } };
      closingElement?: { start?: number } | null;
    };
    if (
      n.type === "JSXElement" &&
      n.openingElement?.name?.type === "JSXIdentifier" &&
      n.openingElement.name.name === "body" &&
      typeof n.closingElement?.start === "number"
    ) {
      at = n.closingElement.start;
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "extra") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (typeof value === "object") visit(value);
    }
  };
  visit(ast.program);
  if (at < 0) return code;
  return `${code.slice(0, at)}<script src="${SCRIPT_URL}" async />${code.slice(at)}`;
}

/** The origin of a URL, or null when it isn't an http(s) one. */
export function editorOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Runs inside the preview page. It does nothing until the Locus editor framing the page sends
 * `enable`; then hovering outlines elements, a click selects one (Shift or Ctrl/Cmd adds more),
 * and a double-click edits plain text in place; Ctrl+Z and Ctrl+Y go to the editor. It only reports what was clicked and shows
 * changes the editor sends (text and a few attributes, never anything that runs); saving
 * happens in Locus. It holds no credentials and only talks to the window that framed it, and
 * only when that window is one of `origins` (the Locus web app).
 */
export function visualEditsScript(origins: string[], draft = ""): string {
  return `(function () {
  if (window.__locusVisualEdits || window.parent === window) return;
  window.__locusVisualEdits = true;
  var SRC = ${JSON.stringify(SOURCE_ATTR)};
  var MSG = ${JSON.stringify(VISUAL_EDITS_MESSAGE)};
  var ORIGINS = ${JSON.stringify(origins)};
  var DRAFT = ${JSON.stringify(draft)};
  var SHOWN = { src: 1, alt: 1, href: 1, className: 1, placeholder: 1, newTab: 1 };
  var parentOrigin = null;
  var enabled = false;
  var frameLoop = 0;
  var selected = [];
  var hovered = null;
  var editing = null;
  var editingFrom = "";
  var path = location.pathname;
  var layer = null;

  function post(message) {
    if (!parentOrigin) return;
    message.source = MSG;
    window.parent.postMessage(message, parentOrigin);
  }

  function located(el) {
    while (el && el.nodeType === 1) {
      if (el.hasAttribute(SRC)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function plainText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 1) return null;
    }
    var text = el.textContent || "";
    return text.trim() ? text : null;
  }

  // The image's own address: next/image serves it through /_next/image?url=...
  function imageSrc(el) {
    var src = el.getAttribute("src");
    if (!src) return src;
    try {
      var u = new URL(src, location.href);
      if (u.origin === location.origin && u.pathname === "/_next/image" && u.searchParams.get("url")) {
        return u.searchParams.get("url");
      }
    } catch (e) {}
    return src;
  }

  function info(el) {
    var link = el.closest("a");
    return {
      target: el.getAttribute(SRC),
      tag: el.tagName.toLowerCase(),
      text: plainText(el),
      className: el.getAttribute("class") || "",
      src: el.tagName === "IMG" ? imageSrc(el) : null,
      alt: el.tagName === "IMG" ? el.getAttribute("alt") || "" : null,
      href: el.tagName === "A" ? el.getAttribute("href") : null,
      newTab: el.tagName === "A" ? el.getAttribute("target") === "_blank" : null,
      placeholder: el.hasAttribute("placeholder") ? el.getAttribute("placeholder") : null,
      inLink: !!link && link !== el
    };
  }

  function box(color, dashed) {
    var b = document.createElement("div");
    b.style.cssText = "position:fixed;pointer-events:none;box-sizing:border-box;border-radius:2px;" +
      "border:2px " + (dashed ? "dashed " : "solid ") + color + ";";
    layer.appendChild(b);
    return b;
  }

  function place(b, el) {
    var r = el.getBoundingClientRect();
    b.style.left = r.left + "px";
    b.style.top = r.top + "px";
    b.style.width = r.width + "px";
    b.style.height = r.height + "px";
  }

  function draw() {
    frameLoop = 0;
    if (!enabled || !layer) return;
    if (location.pathname !== path) {
      path = location.pathname;
      selected = [];
      post({ type: "ready", path: path, theme: theme(), draft: DRAFT });
      report();
    }
    layer.innerHTML = "";
    if (hovered && selected.indexOf(hovered) < 0 && hovered.isConnected) place(box("#3b82f6", true), hovered);
    for (var i = 0; i < selected.length; i++) {
      if (selected[i].isConnected) place(box("#2563eb", false), selected[i]);
    }
    frameLoop = requestAnimationFrame(draw);
  }

  function report() {
    selected = selected.filter(function (el) { return el.isConnected; });
    post({ type: "selection", items: selected.map(info) });
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    layer = document.createElement("div");
    layer.setAttribute("data-locus-overlay", "");
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    document.documentElement.appendChild(layer);
    if (!frameLoop) frameLoop = requestAnimationFrame(draw);
  }

  function disable() {
    finishEditing(true);
    enabled = false;
    selected = [];
    hovered = null;
    if (frameLoop) cancelAnimationFrame(frameLoop);
    frameLoop = 0;
    if (layer) layer.remove();
    layer = null;
  }

  function startEditing(el) {
    if (plainText(el) === null) return;
    finishEditing(false);
    editing = el;
    editingFrom = el.textContent || "";
    el.setAttribute("contenteditable", "plaintext-only");
    if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  }

  function finishEditing(revert) {
    if (!editing) return;
    var el = editing;
    editing = null;
    el.removeAttribute("contenteditable");
    if (revert) { el.textContent = editingFrom; return; }
    var to = el.textContent || "";
    if (to !== editingFrom) {
      post({ type: "text", target: el.getAttribute(SRC), from: editingFrom, to: to });
    }
    report();
  }

  function insideEditing(e) {
    return editing && editing.contains(e.target);
  }

  // In select mode the page's own controls (menus, dialogs, links, forms) don't react.
  ["pointerdown", "mousedown", "pointerup", "mouseup", "touchstart"].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (!enabled || insideEditing(e)) return;
      e.stopPropagation();
      if (type === "mousedown") e.preventDefault();
    }, true);
  });

  document.addEventListener("mousemove", function (e) {
    if (!enabled) return;
    hovered = located(e.target);
  }, true);

  document.addEventListener("click", function (e) {
    if (!enabled) return;
    if (insideEditing(e)) { e.preventDefault(); return; }
    e.preventDefault();
    e.stopPropagation();
    finishEditing(false);
    var el = located(e.target);
    if (!el) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      var at = selected.indexOf(el);
      if (at >= 0) selected.splice(at, 1); else selected.push(el);
    } else {
      selected = [el];
    }
    report();
  }, true);

  document.addEventListener("dblclick", function (e) {
    if (!enabled) return;
    e.preventDefault();
    e.stopPropagation();
    var el = located(e.target);
    if (el) { selected = [el]; report(); startEditing(el); }
  }, true);

  document.addEventListener("submit", function (e) {
    if (enabled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  document.addEventListener("keydown", function (e) {
    // Undo and redo belong to the editor, unless a field of the page is being typed in.
    var key = (e.key || "").toLowerCase();
    if (!editing && (e.ctrlKey || e.metaKey) && !e.altKey && (key === "z" || (key === "y" && !e.shiftKey)) &&
        !(e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]"))) {
      e.preventDefault();
      post({ type: key === "z" && !e.shiftKey ? "undo" : "redo" });
      return;
    }
    if (!enabled) return;
    if (editing) {
      if (e.key === "Escape") { e.preventDefault(); finishEditing(true); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finishEditing(false); }
      return;
    }
    if (e.key === "Escape") { selected = []; report(); }
  }, true);

  document.addEventListener("focusout", function (e) {
    if (editing && e.target === editing) finishEditing(false);
  }, true);

  // The site's theme colours, so the editor's swatches show the real ones.
  function theme() {
    var names = ["primary", "primary-foreground", "secondary", "accent", "muted",
      "muted-foreground", "foreground", "background"];
    var style = getComputedStyle(document.documentElement);
    var out = {};
    names.forEach(function (n) {
      var v = style.getPropertyValue("--" + n).trim();
      if (v && v.length < 80) out[n] = v;
    });
    return out;
  }

  function each(target, fn) {
    var all = document.querySelectorAll("[" + SRC + "]");
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute(SRC) === target) fn(all[i]);
    }
  }

  // Shows a change before it is saved. Text changes the selected copy (one element in a list
  // can render many times), or after a reload the copy still showing the old text; attributes
  // change every copy, as saving them would. Only the editor's own fields can be set.
  function show(change) {
    if (typeof change.target !== "string") return;
    if (change.kind === "text") {
      var value = String(change.value);
      var picked = selected.filter(function (el) { return el.getAttribute(SRC) === change.target; });
      if (picked.length === 0) {
        each(change.target, function (el) {
          if (picked.length === 0 && plainText(el) !== null && el.textContent === change.from) picked.push(el);
        });
      }
      picked.forEach(function (el) { if (plainText(el) !== null) el.textContent = value; });
      return;
    }
    if (!SHOWN.hasOwnProperty(change.name)) return;
    each(change.target, function (el) {
      if (change.name === "className") el.setAttribute("class", String(change.value));
      else if (change.name === "newTab") {
        if (change.value) el.setAttribute("target", "_blank"); else el.removeAttribute("target");
      } else if (change.name === "href" || change.name === "src") {
        var v = String(change.value).replace(/[\\u0000-\\u0020]/g, "");
        if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^(https?|mailto|tel):/i.test(v)) return;
        el.setAttribute(change.name, String(change.value));
        if (change.name === "src") el.removeAttribute("srcset");
      } else {
        el.setAttribute(change.name, String(change.value));
      }
    });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent || ORIGINS.indexOf(e.origin) < 0) return;
    var data = e.data;
    if (!data || data.source !== MSG) return;
    parentOrigin = e.origin;
    if (data.type === "hello") post({ type: "ready", path: location.pathname, theme: theme(), draft: DRAFT });
    else if (data.type === "enable") { enable(); report(); }
    else if (data.type === "disable") disable();
    else if (data.type === "clear") { selected = []; report(); }
    else if (data.type === "show" && data.change) show(data.change);
  });

  // Tell the framing window the script is here (nothing else), so an editor can say hello.
  window.parent.postMessage({ source: MSG, type: "announce" }, "*");
})();
`;
}
