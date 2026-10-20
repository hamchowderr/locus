import { useAimock } from "@locus/testing";
import { RequestContext } from "@mastra/core/request-context";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSiteBuilderAgent } from "./agent.ts";
import { ImageError, OpenAiImageGenerator } from "./images.ts";
import { type TestSession, testSession } from "./test-session.ts";

// AIMock serves OpenAI's images endpoint, so the real generator runs over HTTP with no
// provider, no key and no cost. The hand-written fetch fakes in images.test.ts prove the
// request shape; these prove it against an implementation of the API.
const mock = useAimock();
let t: TestSession | undefined;
afterEach(() => t?.close());
// useAimock keeps fixtures and requests between tests; image fixtures match on the prompt alone.
beforeEach(() => {
  mock().llm.clearFixtures();
  mock().llm.clearRequests();
});

const PNG = Buffer.from("not really a png");
const imagePath = "/v1/images/generations";
const imageRequests = () =>
  mock()
    .llm.getRequests()
    .filter((r) => r.path === imagePath);

function generator() {
  return new OpenAiImageGenerator({ apiKey: "test-key", baseUrl: `${mock().url}/v1` });
}

describe("images through AIMock", () => {
  test("a generated image arrives as the bytes the service sent", async () => {
    mock().llm.onImage(/lighthouse/, { image: { b64Json: PNG.toString("base64") } });
    const image = await generator().generate({ prompt: "a lighthouse at dusk", shape: "square" });
    expect(Buffer.from(image.bytes)).toEqual(PNG);
    expect(image).toMatchObject({ mediaType: "image/png", model: "gpt-image-1" });
    const [request] = imageRequests();
    // The journal keeps the prompt as a user message.
    expect(request?.body).toMatchObject({
      model: "gpt-image-1",
      messages: [{ role: "user", content: "a lighthouse at dusk" }],
    });
  });

  test("an image service that only gives a link is a clear failure, not a broken file", async () => {
    // Locus asks for base64 and writes those bytes; a URL-only answer must not become a file.
    mock().llm.onImage(/lighthouse/, { image: { url: "https://images.test/a.png" } });
    await expect(generator().generate({ prompt: "a lighthouse", shape: "square" })).rejects.toThrow(
      ImageError,
    );
  });

  test("a refused prompt says why", async () => {
    mock().llm.on(
      { endpoint: "image", userMessage: /lighthouse/ },
      {
        error: { message: "Your prompt was rejected.", type: "invalid_request_error" },
        status: 400,
      },
    );
    await expect(generator().generate({ prompt: "a lighthouse", shape: "square" })).rejects.toThrow(
      "The image wasn't made: Your prompt was rejected.",
    );
  });

  test.each([
    ["a rate limit", { rateLimitRate: 1 }, 429],
    ["a server error", { dropRate: 1 }, 500],
    ["a garbled reply", { malformedRate: 1 }, 200],
  ])("%s fails once, and is not retried, since each try costs money", async (_, chaos, status) => {
    mock().llm.onImage(/lighthouse/, { image: { b64Json: PNG.toString("base64") } });
    mock().llm.setChaos(chaos);
    try {
      await expect(
        generator().generate({ prompt: "a lighthouse", shape: "landscape" }),
      ).rejects.toThrow(ImageError);
    } finally {
      mock().llm.clearChaos();
    }
    expect(imageRequests().map((r) => r.response.status)).toEqual([status]);
  });

  // Level 1 end to end: AIMock plays both the model and the image service.
  test("the builder generates an image into the site and meters it", {
    timeout: 30_000,
  }, async () => {
    t = await testSession({ images: generator() });
    mock().llm.onImage(/dental office/, { image: { b64Json: PNG.toString("base64") } });
    mock().llm.on(
      { userMessage: /add a hero image/i, hasToolResult: false },
      {
        toolCalls: [
          {
            id: "call_image",
            name: "generate_image",
            arguments: JSON.stringify({
              prompt: "a bright, calm dental office",
              path: "public/images/hero.png",
            }),
          },
        ],
      },
    );
    mock().llm.on({ toolCallId: "call_image" }, { content: "Added a hero image." });

    const session = t.session;
    const agent = createSiteBuilderAgent({
      model: { id: "anthropic/claude-test", url: `${mock().url}/v1`, apiKey: "test-key" },
      resolve: async () => session,
    });
    const result = await agent.generate("Add a hero image", {
      maxSteps: 4,
      requestContext: new RequestContext([["siteId", "site-1"]]),
    });

    expect(result.text).toBe("Added a hero image.");
    const saved = await session.workspace.readFile("public/images/hero.png");
    expect(Buffer.from(saved ?? "")).toEqual(PNG);
    expect(t.usage).toEqual([{ kind: "image", count: 1, size: "large", model: "gpt-image-1" }]);
    expect(imageRequests()).toHaveLength(1);
  });
});
