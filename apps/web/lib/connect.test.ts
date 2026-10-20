import { afterEach, describe, expect, it, vi } from "vitest";
import { ghlLivePayments } from "./connect.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// `ghlLivePayments` warns once per process, so the case that warns runs last.
describe("site checkout's payment mode", () => {
  it("is live only with LOCUS_GHL_LIVE_PAYMENTS=true", () => {
    vi.stubEnv("GHL_MODE", "live");
    for (const [setting, live] of [
      ["true", true],
      ["false", false],
      ["1", false],
    ] as const) {
      vi.stubEnv("LOCUS_GHL_LIVE_PAYMENTS", setting);
      expect(ghlLivePayments()).toBe(live);
    }
  });

  it("says nothing when the setting is given, or against the stub", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GHL_MODE", "live");
    vi.stubEnv("LOCUS_GHL_LIVE_PAYMENTS", "false");
    expect(ghlLivePayments()).toBe(false);
    vi.stubEnv("GHL_MODE", "stub");
    vi.stubEnv("LOCUS_GHL_LIVE_PAYMENTS", undefined);
    expect(ghlLivePayments()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once when it runs against live GHL with the setting left out", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GHL_MODE", "live");
    vi.stubEnv("LOCUS_GHL_LIVE_PAYMENTS", undefined);
    expect(ghlLivePayments()).toBe(false);
    expect(ghlLivePayments()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("LOCUS_GHL_LIVE_PAYMENTS is not set");
  });
});
