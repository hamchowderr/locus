import { describe, expect, it } from "vitest";
import { differences, EditHistory, type Pending, readStored, sameAt, withEdit } from "./history";
import { type PendingEdit, undoKey } from "./use-visual-edits";

const text = (from: string, to: string): PendingEdit => ({
  kind: "text",
  target: "app/page.tsx:10",
  from,
  to,
});
const color = (from: string, to: string): PendingEdit => ({
  kind: "attr",
  target: "app/page.tsx:40",
  name: "className",
  from,
  to,
});

/** Makes a change the way the editor does: a history step, then the new set. */
function make(history: EditHistory, current: Pending, edit: PendingEdit, at: number): Pending {
  const { next, key } = withEdit(current, edit);
  history.step(current, key, at);
  return next;
}

describe("visual edits undo", () => {
  it("undoes and redoes changes one at a time", () => {
    const history = new EditHistory();
    const a = make(history, new Map(), text("Hello", "Hi"), 0);
    const b = make(history, a, color("text-sm", "text-lg"), 5_000);

    const back = history.undo(b);
    expect(back).toBe(a);
    expect(history.undo(a as Pending)?.size).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(history.redo(new Map())).toBe(a);
    expect(history.redo(a)).toBe(b);
    expect(history.canRedo).toBe(false);
  });

  it("undoes quick typing in one field as one step", () => {
    const history = new EditHistory();
    let pending: Pending = new Map();
    pending = make(history, pending, text("Hello", "H"), 0);
    pending = make(history, pending, text("H", "Hi"), 200);
    pending = make(history, pending, text("Hi", "Hi!"), 400);
    expect([...pending.values()]).toEqual([text("Hello", "Hi!")]);
    expect(history.undo(pending)?.size).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it("forgets what could be redone once something new is changed", () => {
    const history = new EditHistory();
    const a = make(history, new Map(), text("Hello", "Hi"), 0);
    const back = history.undo(a) as Pending;
    make(history, back, color("text-sm", "text-lg"), 5_000);
    expect(history.canRedo).toBe(false);
  });

  it("tells the page how to put back a change that was undone", () => {
    const changed = withEdit(new Map(), text("Hello", "Hi")).next;
    expect(differences(changed, new Map())).toEqual([text("Hi", "Hello")]);
    const styled = withEdit(new Map(), color("text-sm", "text-lg")).next;
    expect(differences(styled, new Map())).toEqual([color("text-lg", "text-sm")]);
    expect(differences(new Map(), styled)).toEqual([color("text-sm", "text-lg")]);
  });

  it("finds the copy to change by the text the page shows now", () => {
    const history = new EditHistory();
    const hi = make(history, new Map(), text("Hello", "Hi"), 0);
    const hey = make(history, hi, text("Hi", "Hey"), 5_000);
    expect([...hey.values()]).toEqual([text("Hello", "Hey")]);
    const back = history.undo(hey) as Pending;
    // The page shows "Hey" and must go back to "Hi".
    expect(differences(hey, back)).toEqual([text("Hey", "Hi")]);
    expect(differences(back, hey)).toEqual([text("Hi", "Hey")]);
  });

  it("adds no step for a change that changes nothing", () => {
    const styled = withEdit(new Map(), color("text-sm", "text-lg"));
    const again = withEdit(styled.next, color("text-lg", "text-lg"));
    expect(sameAt(styled.next, again.next, again.key)).toBe(true);
  });

  it("knows the undo and redo keys", () => {
    const k = (key: string, more: Partial<Parameters<typeof undoKey>[0]> = {}) =>
      undoKey({ key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...more });
    expect(k("z")).toBe("undo");
    expect(k("Z", { shiftKey: true })).toBe("redo");
    expect(k("y")).toBe("redo");
    expect(k("z", { ctrlKey: false, metaKey: true })).toBe("undo");
    expect(k("y", { ctrlKey: false, metaKey: true })).toBeNull();
    expect(k("z", { ctrlKey: false })).toBeNull();
    expect(k("s")).toBeNull();
  });
});

describe("visual edits kept in the tab", () => {
  it("reads back the changes it stored", () => {
    const edits: PendingEdit[] = [
      text("Hello", "Hi"),
      color("text-sm", "text-lg"),
      { kind: "newTab", target: "app/page.tsx:80", from: false, on: true },
    ];
    expect([...readStored(JSON.stringify(edits)).values()]).toEqual(edits);
  });

  it("drops anything that isn't a change the editor makes", () => {
    const stored = JSON.stringify([
      { kind: "attr", target: "app/page.tsx:1", name: "onClick", from: "", to: "alert(1)" },
      { kind: "script", target: "app/page.tsx:1" },
      { kind: "text", target: 5, from: "a", to: "b" },
      "nonsense",
    ]);
    expect(readStored(stored).size).toBe(0);
    expect(readStored("{not json").size).toBe(0);
    expect(readStored(null).size).toBe(0);
  });
});
