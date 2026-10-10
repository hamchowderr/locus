import { describe, expect, it, vi } from "vitest";
import { consoleEmail, emailFromEnv } from "./email.ts";

const message = { to: "a@agency.test", subject: "Hi", text: "Open https://x.test/verify" };

describe("emailFromEnv", () => {
  it("prints to the console by default outside production", () => {
    expect(emailFromEnv({})).toBe(consoleEmail);
    expect(emailFromEnv({ NODE_ENV: "development" })).toBe(consoleEmail);
  });

  it("refuses to guess in production", () => {
    expect(() => emailFromEnv({ NODE_ENV: "production" })).toThrow(/EMAIL_MODE/);
    expect(() => emailFromEnv({ EMAIL_MODE: "smtp" })).toThrow(/EMAIL_MODE/);
  });

  it("needs a key and a sender for Resend", () => {
    expect(() => emailFromEnv({ EMAIL_MODE: "resend", RESEND_API_KEY: "k" })).toThrow(/EMAIL_FROM/);
  });

  it("sends through Resend's API and fails loudly when refused", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const send = emailFromEnv(
      { EMAIL_MODE: "resend", RESEND_API_KEY: "key", EMAIL_FROM: "Locus <no-reply@x.test>" },
      fetchImpl as unknown as typeof fetch,
    );
    await send(message);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer key");
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Locus <no-reply@x.test>",
      to: ["a@agency.test"],
      subject: "Hi",
      text: message.text,
    });

    fetchImpl.mockResolvedValueOnce(new Response("bad sender", { status: 422 }));
    await expect(send(message)).rejects.toThrow(/422 bad sender/);
  });
});
