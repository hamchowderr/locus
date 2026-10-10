import { toNextJsHandler } from "better-auth/next-js";
import { locus, NotConfigured } from "@/lib/locus";

async function handler(request: Request) {
  try {
    return await locus().auth.handler(request);
  } catch (error) {
    if (error instanceof NotConfigured) {
      return Response.json({ error: "Locus is not configured yet." }, { status: 503 });
    }
    throw error;
  }
}

export const { GET, POST } = toNextJsHandler(handler);
