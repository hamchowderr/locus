import { describe, expect, it } from "vitest";
import { chatShowsInFull, chatStep } from "./chat-steps";

const call = (name: string, args: unknown) => ({ name, args });

describe("chatStep", () => {
  it("tells HighLevel work in plain words", () => {
    expect(chatStep(call("load_skill", { category: "contacts" }), undefined)?.label).toBe(
      "Read the contacts guide",
    );
    expect(
      chatStep(
        call("query_data", {
          sources: [
            { operation: "contacts.search-contacts" },
            { operation: "opportunities.search-opportunity" },
            { operation: "contacts.get-contact" },
          ],
        }),
        undefined,
      )?.label,
    ).toBe("Looked up contacts and opportunities");
    expect(
      chatStep(call("perform_action", { operation: "contacts.add-tags" }), undefined)?.label,
    ).toBe("Add tags");
  });

  it("names the app an app tool belongs to", () => {
    expect(chatStep(call("use_app", { tool: "GMAIL_SEND_EMAIL" }), undefined)?.label).toBe(
      "Gmail: send email",
    );
  });

  it("marks a failure the tool returned, with its reason", () => {
    expect(
      chatStep(call("perform_action", { operation: "contacts.delete-contact" }), {
        result: { error: "Contact not found." },
      }),
    ).toEqual({ label: "Delete contact", detail: "Contact not found.", failed: true });
  });

  it("leaves other tools to the chat's own view", () => {
    expect(chatStep(call("start_thread", { title: "x" }), undefined)).toBeNull();
  });
});

describe("chatShowsInFull", () => {
  it("keeps an app search that offers a Connect button in full", () => {
    const find = call("find_app_tools", { task: "send an email" });
    expect(chatShowsInFull(find, { result: { tools: [], notConnected: ["gmail"] } })).toBe(true);
    expect(chatShowsInFull(find, { result: { tools: [] } })).toBe(false);
    expect(chatShowsInFull(call("use_app", {}), undefined)).toBe(false);
  });
});
