import { useAimock } from "@locus/testing";
import { RequestContext } from "@mastra/core/request-context";
import { afterEach, expect, test } from "vitest";
import { createSiteBuilderAgent, siteBuilderMode } from "./agent.ts";
import { type TestSession, testSession } from "./test-session.ts";

const mock = useAimock();
let t: TestSession;
afterEach(() => t?.close());

// Level-1 end to end: AIMock plays the model, so this proves the wiring (Mastra calls the
// builder's tools, they act on the site the host resolved, the results flow back), not the
// model's judgement.
test("the builder writes a page, checks the build and saves a version", async () => {
  t = await testSession();
  mock().llm.on(
    { userMessage: /add an about page/i, hasToolResult: false },
    {
      toolCalls: [
        {
          id: "call_write",
          name: "write_file",
          arguments: JSON.stringify({
            path: "app/about/page.tsx",
            content: "export default function About() { return <h1>About</h1>; }\n",
          }),
        },
      ],
    },
  );
  mock().llm.on(
    { toolCallId: "call_write" },
    { toolCalls: [{ id: "call_check", name: "check_site", arguments: "{}" }] },
  );
  mock().llm.on(
    { toolCallId: "call_check" },
    {
      toolCalls: [
        { id: "call_save", name: "save_version", arguments: '{"message":"Add an about page"}' },
      ],
    },
  );
  mock().llm.on({ toolCallId: "call_save" }, { content: "Added an About page." });

  const seen: unknown[] = [];
  const agent = createSiteBuilderAgent({
    model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
    resolve: async (requestContext) => {
      seen.push((requestContext as RequestContext).get("siteId"));
      return t.session;
    },
  });
  const requestContext = new RequestContext([["siteId", "site-1"]]);
  const result = await agent.generate("Add an about page", { maxSteps: 6, requestContext });

  expect(result.text).toBe("Added an About page.");
  expect(await t.session.workspace.readFile("app/about/page.tsx")).toContain("About");
  const [version] = await t.session.workspace.listVersions();
  expect(version).toMatchObject({ number: 1, message: "Add an about page", source: "agent" });
  // Every tool call resolved the site from the host's request context.
  expect(seen).toEqual(["site-1", "site-1", "site-1"]);
  expect(t.runtimes.runtimes.get("site-1")?.readText("app/about/page.tsx")).toContain("About");
});

test("the mode carries the instructions and every builder tool", () => {
  const mode = siteBuilderMode({ resolve: async () => t.session });
  expect(mode.id).toBe("site-builder");
  expect(Object.keys(mode.additionalTools)).toEqual(
    expect.arrayContaining([
      "write_file",
      "check_site",
      "preview",
      "save_version",
      "generate_image",
    ]),
  );
});
