import { describe, expect, it } from "vitest";
import {
  ALIGNMENT,
  BACKGROUND,
  currentOf,
  groupsFor,
  PADDING,
  setGroup,
  TEXT_COLOR,
  TEXT_SIZE,
} from "./classes";

describe("visual edit style classes", () => {
  const heading =
    "mt-6 max-w-3xl text-4xl font-bold text-balance sm:text-6xl text-muted-foreground";

  it("tells colour, size and alignment apart", () => {
    expect(currentOf(heading, TEXT_COLOR)).toBe("text-muted-foreground");
    expect(currentOf(heading, TEXT_SIZE)).toBe("text-4xl");
    expect(currentOf(heading, ALIGNMENT)).toBe("");
    expect(currentOf("bg-primary/90 bg-cover", BACKGROUND)).toBe("bg-primary/90");
  });

  it("swaps one group's class in place and leaves variants alone", () => {
    expect(setGroup(heading, TEXT_SIZE, "text-5xl")).toBe(
      "mt-6 max-w-3xl text-5xl font-bold text-balance sm:text-6xl text-muted-foreground",
    );
    expect(setGroup(heading, TEXT_COLOR, "text-primary")).toContain("sm:text-6xl text-primary");
    expect(setGroup("rounded p-4", PADDING, "")).toBe("rounded");
    expect(setGroup("", PADDING, "p-8")).toBe("p-8");
  });

  it("leaves classes that only look like colours alone", () => {
    expect(setGroup("bg-[url('/hero.jpg')] bg-cover p-4", BACKGROUND, "bg-primary")).toBe(
      "bg-[url('/hero.jpg')] bg-cover p-4 bg-primary",
    );
    expect(setGroup("bg-top bg-no-repeat bg-white", BACKGROUND, "bg-black")).toBe(
      "bg-top bg-no-repeat bg-black",
    );
    expect(setGroup("text-[15px] text-muted-foreground", TEXT_COLOR, "text-primary")).toBe(
      "text-[15px] text-primary",
    );
    expect(setGroup("text-shadow-lg text-white", TEXT_COLOR, "text-black")).toBe(
      "text-shadow-lg text-black",
    );
    expect(currentOf("bg-[#ff0000] p-2", BACKGROUND)).toBe("bg-[#ff0000]");
  });

  it("offers text styles only where there is text", () => {
    expect(groupsFor({ text: "Hi", tag: "div" })).toContain(TEXT_COLOR);
    expect(groupsFor({ text: null, tag: "img" })).not.toContain(TEXT_COLOR);
  });
});
