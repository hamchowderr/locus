import { afterEach, describe, expect, it, vi } from "vitest";
import { readConnectorsOff, setConnectorOff } from "./chat-connectors";

function fakeStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
    items,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("connectors turned off for a chat", () => {
  it("keeps each sub-account's switches apart, and forgets an empty list", () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    expect(setConnectorOff("client-a", "gmail", true)).toEqual(["gmail"]);
    expect(setConnectorOff("client-a", "slack", true)).toEqual(["gmail", "slack"]);
    expect(readConnectorsOff("client-b")).toEqual([]);
    expect(setConnectorOff("client-a", "gmail", false)).toEqual(["slack"]);
    setConnectorOff("client-a", "slack", false);
    expect(storage.items.size).toBe(0);
  });

  it("reads nothing from storage it can't use or doesn't recognise", () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    storage.setItem("locus:connectors-off:c", "{not json");
    expect(readConnectorsOff("c")).toEqual([]);
    storage.setItem("locus:connectors-off:c", JSON.stringify(["gmail", 3]));
    expect(readConnectorsOff("c")).toEqual(["gmail"]);
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(readConnectorsOff("c")).toEqual([]);
    expect(setConnectorOff("c", "gmail", true)).toEqual(["gmail"]);
  });
});
