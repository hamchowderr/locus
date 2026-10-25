import { describe, expect, it, vi } from "vitest";
import { RELAYED_HEADER, relayTarget, relayToTarget } from "./ghl-relay";

describe("relaying new GHL messages to another Locus", () => {
  it("is off unless an https address is set, for listed locations only", () => {
    const on = { LOCUS_GHL_RELAY_LOCATIONS: "loc-test, loc-2" };
    expect(relayTarget("loc-test", on)).toBeNull();
    expect(relayTarget("loc-test", { ...on, LOCUS_GHL_RELAY_URL: " " })).toBeNull();
    expect(relayTarget("loc-test", { ...on, LOCUS_GHL_RELAY_URL: "not a url" })).toBeNull();
    expect(
      relayTarget("loc-test", { ...on, LOCUS_GHL_RELAY_URL: "http://staging.example/x" }),
    ).toBeNull();
    const env = { ...on, LOCUS_GHL_RELAY_URL: "https://staging.example/api/webhooks/crm" };
    expect(relayTarget("loc-test", env)?.href).toBe("https://staging.example/api/webhooks/crm");
    expect(relayTarget("loc-2", env)).not.toBeNull();
    // Any other client's messages stay put, and so does everything with no list.
    expect(relayTarget("loc-other", env)).toBeNull();
    expect(relayTarget(undefined, env)).toBeNull();
    expect(relayTarget("loc-test", { ...env, LOCUS_GHL_RELAY_LOCATIONS: "" })).toBeNull();
    // Never to itself.
    expect(
      relayTarget("loc-test", { ...env, VERCEL_PROJECT_PRODUCTION_URL: "staging.example" }),
    ).toBeNull();
  });

  it("sends the body unchanged with GHL's signature, marked as a copy", async () => {
    const send = vi.fn(async () => new Response("{}"));
    const target = new URL("https://staging.example/api/webhooks/crm");
    await relayToTarget(target, '{"type":"InboundMessage"}', "sig", send as typeof fetch);
    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(target.href);
    expect(init.body).toBe('{"type":"InboundMessage"}');
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ "x-ghl-signature": "sig", [RELAYED_HEADER]: "1" });
  });

  it("never throws: a failing or unreachable target is only logged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const target = new URL("https://staging.example/api/webhooks/crm");
    await relayToTarget(
      target,
      "{}",
      "sig",
      (async () => new Response("", { status: 500 })) as typeof fetch,
    );
    await relayToTarget(target, "{}", "sig", (async () => {
      throw new Error("down");
    }) as typeof fetch);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
