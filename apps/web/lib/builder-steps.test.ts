import { describe, expect, it } from "vitest";
import {
  buildError,
  builderStep,
  callsChangedFiles,
  changedFiles,
  checkFailure,
  lastCheckFailure,
  savedVersion,
} from "./builder-steps";

const call = (name: string, args: unknown, id = name) => ({ id, name, args });

describe("builderStep", () => {
  it("tells file work in plain words", () => {
    expect(builderStep(call("files", { action: "edit", path: "app/page.tsx" }), undefined)).toEqual(
      { label: "Edited app/page.tsx" },
    );
    expect(builderStep(call("files", { action: "delete", paths: ["a", "b"] }), undefined)).toEqual({
      label: "Deleted 2 files",
    });
    expect(builderStep(call("files", { action: "list" }), undefined)?.label).toBe(
      "Looked over the site's files",
    );
  });

  it("names a reference by its site, not its full address", () => {
    expect(
      builderStep(call("fetch_reference", { url: "https://example.com/a?b=c" }), undefined)?.label,
    ).toBe("Looked at example.com");
  });

  it("says when a check found a problem", () => {
    expect(builderStep(call("check_site", {}), { result: { ok: false } })?.label).toBe(
      "Checked the site and found a problem",
    );
    expect(builderStep(call("check_site", {}), { result: { ok: true } })).toEqual({
      label: "Checked the site",
    });
  });

  it("marks a failed build as failed, with the line that says what went wrong", () => {
    // check_site returns a failed build as a normal result, not an error.
    const output = [
      "   ▲ Next.js 16.0.0",
      "   Creating an optimized production build ...",
      "Failed to compile.",
      "",
      "./app/page.tsx:3:10",
      "Type error: Cannot find name 'Hero'.",
    ].join("\n");
    expect(
      builderStep(call("check_site", {}), { result: { ok: false, step: "build", output } }),
    ).toEqual({
      label: "Checked the site and found a problem",
      detail: "Type error: Cannot find name 'Hero'.",
      failed: true,
    });
    // No output still says something, and a long line is cut to fit.
    expect(
      builderStep(call("check_site", {}), { result: { ok: false, step: "install" } })?.detail,
    ).toBe("The install failed.");
    expect(buildError(`Error: ${"x".repeat(300)}`)).toHaveLength(200);
    // The preview's own ok: false is the preview's business, not a build check.
    expect(checkFailure({ name: "preview" }, { result: { ok: false, output: "Error" } })).toBe(
      undefined,
    );
  });

  it("marks a failure the tool returned, with its reason", () => {
    // The builder's tools return their errors as results rather than throw them.
    expect(
      builderStep(call("files", { action: "read", path: "x.ts" }), {
        result: { error: "x.ts doesn't exist." },
      }),
    ).toEqual({ label: "Read x.ts", detail: "x.ts doesn't exist.", failed: true });
    // Input that doesn't fit the tool.
    expect(
      builderStep(call("files", { action: "edit", path: "x.ts" }), {
        result: { error: true, message: "edit needs the text to find" },
      }),
    ).toEqual({ label: "Edited x.ts", detail: "edit needs the text to find", failed: true });
    // A tool that threw.
    expect(
      builderStep(call("files", { action: "edit", path: "x.ts" }), { isError: true })?.failed,
    ).toBe(true);
  });

  it("says what a HighLevel piece did", () => {
    expect(builderStep(call("crm", { action: "add_tracking" }), undefined)?.label).toBe(
      "Added the tracking script to every page",
    );
    expect(builderStep(call("crm", { action: "calendars" }), undefined)?.label).toBe(
      "Looked at the calendars in HighLevel",
    );
  });

  it("tells a save by how it went", () => {
    const save = call("versions", { action: "save", message: "New hero" });
    expect(builderStep(save, undefined)?.label).toBe("Saving a version");
    expect(builderStep(save, { result: { saved: false } })?.label).toBe("Nothing new to save");
    expect(builderStep(save, { result: { error: "save needs a message" } })?.label).toBe(
      "Couldn't save a version",
    );
  });

  it("leaves tools it doesn't know to the plain view", () => {
    expect(builderStep(call("find_app_tools", {}), undefined)).toBeNull();
  });
});

describe("lastCheckFailure", () => {
  const check = (id: string, result: unknown, isError = false) => ({
    content: [
      { type: "tool_call", id, name: "check_site", args: {} },
      { type: "tool_result", id, name: "check_site", result, isError },
    ],
  });
  const broken = { ok: false, step: "build", output: "Error: Module not found: './hero'" };

  it("is the newest check's failure until a later check passes", () => {
    expect(lastCheckFailure([])).toBeNull();
    expect(lastCheckFailure([check("1", { ok: true }), check("2", broken)])).toBe(
      "Error: Module not found: './hero'",
    );
    expect(lastCheckFailure([check("1", broken), check("2", { ok: true })])).toBeNull();
  });

  it("looks past a check that couldn't run", () => {
    expect(lastCheckFailure([check("1", broken), check("2", { error: "No credits left." })])).toBe(
      "Error: Module not found: './hero'",
    );
    expect(lastCheckFailure([check("1", broken), check("2", undefined, true)])).toBe(
      "Error: Module not found: './hero'",
    );
  });
});

describe("changedFiles", () => {
  const ok = { result: {} };

  it("is true for every builder step that writes the site's files", () => {
    for (const [name, args] of [
      ["files", { action: "write", path: "a.tsx" }],
      ["files", { action: "edit", path: "a.tsx" }],
      ["files", { action: "delete", paths: ["a.tsx"] }],
      ["add_dependency", { package: "zod" }],
      ["add_dependency", { component: "card" }],
      ["generate_image", { path: "public/hero.png" }],
      ["crm", { action: "add_booking" }],
      ["crm", { action: "add_tracking" }],
      ["crm", { action: "use_media" }],
      ["database", { action: "add" }],
      ["versions", { action: "restore", number: 2 }],
    ] as const) {
      expect(changedFiles(call(name, args), ok), `${name} ${JSON.stringify(args)}`).toBe(true);
    }
  });

  it("is false for steps that only look, and for any that failed or hasn't finished", () => {
    for (const [name, args] of [
      ["files", { action: "read", path: "a.tsx" }],
      ["files", { action: "list" }],
      ["crm", { action: "calendars" }],
      ["crm", { action: "media" }],
      ["database", { action: "apply" }],
      ["versions", { action: "save", message: "x" }],
      ["versions", { action: "list" }],
      ["check_site", {}],
      ["preview", {}],
    ] as const) {
      expect(changedFiles(call(name, args), ok), `${name} ${JSON.stringify(args)}`).toBe(false);
    }
    const write = call("files", { action: "write", path: "a.tsx" });
    expect(changedFiles(write, undefined)).toBe(false);
    expect(changedFiles(write, { isError: true })).toBe(false);
    expect(changedFiles(write, { result: { error: "write needs a path" } })).toBe(false);
  });

  it("reads a turn's finished calls from the conversation", () => {
    const messages = [
      {
        content: [
          { type: "tool_call", id: "1", name: "files", args: { action: "read", path: "a" } },
          { type: "tool_call", id: "2", name: "crm", args: { action: "use_media" } },
        ],
      },
      {
        content: [
          { type: "tool_result", id: "1", name: "files", result: { content: "" } },
          { type: "tool_result", id: "2", name: "crm", result: { used: "public/a.png" } },
        ],
      },
    ];
    expect(callsChangedFiles(messages, new Set(["1"]))).toBe(false);
    expect(callsChangedFiles(messages, new Set(["1", "2"]))).toBe(true);
  });
});

describe("savedVersion", () => {
  const edit = call("files", { action: "edit", path: "app/page.tsx" }, "1");
  const write = call("files", { action: "write", path: "components/pricing.tsx" }, "2");
  const again = call("files", { action: "edit", path: "app/page.tsx" }, "3");
  const failed = call("files", { action: "edit", path: "broken.tsx" }, "4");
  const save = call("versions", { action: "save", message: "Added pricing" }, "5");
  const ok = { result: {} };

  it("lists the files the turn changed before the save, once each", () => {
    const turn = [
      { call: edit, result: ok },
      { call: write, result: ok },
      { call: again, result: ok },
      { call: failed, result: { result: { error: "find matched nothing" } } },
      { call: save, result: { result: { saved: true, version: 7 } } },
    ];
    expect(savedVersion(save, turn[4]?.result, turn)).toEqual({
      version: 7,
      message: "Added pricing",
      changed: ["app/page.tsx", "components/pricing.tsx"],
      more: false,
    });
  });

  it("counts only the files since the turn's previous save", () => {
    const first = call("versions", { action: "save", message: "One" }, "0");
    const turn = [
      { call: edit, result: ok },
      { call: first, result: { result: { saved: true, version: 6 } } },
      { call: write, result: ok },
      { call: save, result: { result: { saved: true, version: 7 } } },
    ];
    expect(savedVersion(save, turn[3]?.result, turn)?.changed).toEqual(["components/pricing.tsx"]);
  });

  it("starts again only after a save that made a version", () => {
    const tooShort = call("versions", { action: "save", message: "x" }, "0");
    const turn = [
      { call: edit, result: ok },
      { call: tooShort, result: { result: { error: true, message: "Too short" } } },
      { call: save, result: { result: { saved: true, version: 7 } } },
    ];
    expect(savedVersion(save, turn[2]?.result, turn)?.changed).toEqual(["app/page.tsx"]);
  });

  it("notes changes made by tools that don't name files", () => {
    const component = call("add_dependency", { component: "card" }, "1");
    const lookup = call("crm", { action: "calendars" }, "2");
    const turn = [
      { call: lookup, result: ok },
      { call: save, result: { result: { saved: true, version: 3 } } },
    ];
    expect(savedVersion(save, turn[1]?.result, turn)?.more).toBe(false);
    turn.unshift({ call: component, result: ok });
    expect(savedVersion(save, turn[2]?.result, turn)?.more).toBe(true);
  });

  it("is null for a save that made nothing, and for other calls", () => {
    expect(savedVersion(save, { result: { saved: false } }, [])).toBeNull();
    expect(savedVersion(save, undefined, [])).toBeNull();
    expect(savedVersion(save, { result: { error: "No workspace." } }, [])).toBeNull();
    expect(savedVersion(edit, ok, [])).toBeNull();
  });

  it("carries a publish failure to the card", () => {
    expect(
      savedVersion(save, { result: { saved: true, version: 2, publishError: "No repo." } }, [])
        ?.publishError,
    ).toBe("No repo.");
  });
});
