/** A generated image, ready to write into the site's `public/` folder. */
export interface GeneratedImage {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  /** The model that made it, for metering. */
  model: string;
}

export type ImageShape = "square" | "landscape" | "portrait";

export interface ImageGenerator {
  generate(request: { prompt: string; shape: ImageShape }): Promise<GeneratedImage>;
}

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

export interface OpenAiImagesConfig {
  apiKey: string;
  /** Any OpenAI-compatible images endpoint's base, e.g. `https://api.openai.com/v1`. */
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

const SIZES: Record<ImageShape, string> = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
};

/**
 * Images from an OpenAI-compatible `POST /images/generations` endpoint, returned as base64
 * (`b64_json`). The key is Otaku's own (`LOCUS_IMAGE_API_KEY`); it never reaches a sandbox.
 */
export class OpenAiImageGenerator implements ImageGenerator {
  private readonly config: Required<Omit<OpenAiImagesConfig, "fetch">> & { fetch: typeof fetch };

  constructor(config: OpenAiImagesConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      model: config.model ?? "gpt-image-1",
      fetch: config.fetch ?? fetch,
    };
  }

  async generate({
    prompt,
    shape,
  }: {
    prompt: string;
    shape: ImageShape;
  }): Promise<GeneratedImage> {
    const response = await this.config.fetch(`${this.config.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: this.config.model, prompt, size: SIZES[shape], n: 1 }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      data?: { b64_json?: string }[];
      error?: { message?: string };
    };
    const b64 = body.data?.[0]?.b64_json;
    if (!response.ok || !b64) {
      // The provider's message can describe a refused prompt; it is safe to show the agent.
      throw new ImageError(
        body.error?.message
          ? `The image wasn't made: ${body.error.message}`
          : `The image service failed (${response.status}). Try again or skip the image.`,
      );
    }
    return {
      bytes: new Uint8Array(Buffer.from(b64, "base64")),
      mediaType: "image/png",
      model: this.config.model,
    };
  }
}

/** The image generator from the environment, or null when the deployment has none. */
export function imagesFromEnv(env: NodeJS.ProcessEnv = process.env): ImageGenerator | null {
  const apiKey = env.LOCUS_IMAGE_API_KEY;
  if (!apiKey) return null;
  return new OpenAiImageGenerator({
    apiKey,
    ...(env.LOCUS_IMAGE_BASE_URL ? { baseUrl: env.LOCUS_IMAGE_BASE_URL } : {}),
    ...(env.LOCUS_IMAGE_MODEL ? { model: env.LOCUS_IMAGE_MODEL } : {}),
  });
}
