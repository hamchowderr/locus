import { describe, expect, it } from "vitest";
import { ImageError, imagesFromEnv, OpenAiImageGenerator } from "./images.ts";

describe("OpenAiImageGenerator", () => {
  it("asks for one image of the right size and decodes it", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const images = new OpenAiImageGenerator({
      apiKey: "sk-test",
      baseUrl: "https://images.test/v1/",
      model: "image-model",
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response(
          JSON.stringify({ data: [{ b64_json: Buffer.from("png!").toString("base64") }] }),
        );
      }) as typeof fetch,
    });
    const image = await images.generate({ prompt: "a lighthouse", shape: "portrait" });
    expect(new TextDecoder().decode(image.bytes)).toBe("png!");
    expect(image).toMatchObject({ mediaType: "image/png", model: "image-model" });
    expect(requests[0]?.url).toBe("https://images.test/v1/images/generations");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      model: "image-model",
      prompt: "a lighthouse",
      size: "1024x1536",
      n: 1,
    });
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("Bearer sk-test");
  });

  it("explains a refusal", async () => {
    const images = new OpenAiImageGenerator({
      apiKey: "sk-test",
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: "Prompt rejected" } }), {
          status: 400,
        })) as unknown as typeof fetch,
    });
    await expect(images.generate({ prompt: "x", shape: "square" })).rejects.toThrow(ImageError);
  });

  it("is off without a key", () => {
    expect(imagesFromEnv({})).toBeNull();
    expect(imagesFromEnv({ LOCUS_IMAGE_API_KEY: "k" })).toBeInstanceOf(OpenAiImageGenerator);
  });
});
