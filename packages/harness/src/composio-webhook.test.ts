import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { ComposioWebhookRejected, readComposioWebhook } from "./composio-webhook.ts";

const SECRET = "whsec-test";

/** A delivery as Composio signs it: HMAC-SHA256 over `id.timestamp.body`, base64, `v1,`. */
function delivery(body: object, { secret = SECRET, age = 0 } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) - age);
  const signature = createHmac("sha256", secret)
    .update(`msg_1.${timestamp}.${raw}`)
    .digest("base64");
  const headers = new Headers({
    "webhook-id": "msg_1",
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  });
  return [raw, headers] as const;
}

const expired = (userId: string, toolkit = "SLACK") => ({
  id: "msg_1",
  timestamp: new Date().toISOString(),
  type: "composio.connected_account.expired",
  data: { id: "ca_1", user_id: userId, status: "EXPIRED", toolkit: { slug: toolkit } },
  metadata: { project_id: "pr_1", org_id: "org_1" },
});

const read = (raw: string, headers: Headers) =>
  readComposioWebhook({ apiKey: "test-key", secret: SECRET }, raw, headers);

describe("Composio webhooks", () => {
  test("an expired sign-in names the Locus client and the app", async () => {
    expect(await read(...delivery(expired("locus-client:c1")))).toEqual({
      type: "expired",
      clientId: "c1",
      toolkit: "slack",
    });
  });

  test("a delivery not signed with the secret, or too old, is rejected", async () => {
    await expect(
      read(...delivery(expired("locus-client:c1"), { secret: "other" })),
    ).rejects.toThrow(ComposioWebhookRejected);
    await expect(read(...delivery(expired("locus-client:c1"), { age: 3600 }))).rejects.toThrow(
      ComposioWebhookRejected,
    );
    const [raw] = delivery(expired("locus-client:c1"));
    await expect(read(raw, new Headers())).rejects.toThrow(ComposioWebhookRejected);
  });

  test("an account that isn't a Locus client's, or another event, is ignored", async () => {
    expect(await read(...delivery(expired("someone-else")))).toEqual({ type: "ignored" });
    expect(await read(...delivery(expired("locus-client:")))).toEqual({ type: "ignored" });
    expect(
      await read(
        ...delivery({
          id: "msg_2",
          timestamp: new Date().toISOString(),
          type: "composio.trigger.message",
          data: {},
          metadata: {},
        }),
      ),
    ).toEqual({ type: "ignored" });
  });
});
