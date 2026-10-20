import { timingSafeEqual } from "node:crypto";
import { sendExtraUsage } from "@/lib/extra-usage";
import { configured } from "@/lib/locus";

/**
 * Vercel Cron (`vercel.json`): sends every agency's waiting extra usage to Stripe's meter. Vercel
 * calls it with `Authorization: Bearer $CRON_SECRET`; without that secret set, it answers 404.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const notFound = () => new Response("Not Found", { status: 404 });

function authorized(request: Request, secret: string) {
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !configured()) return notFound();
  if (!authorized(request, secret)) return notFound();
  // Stop starting new work well inside `maxDuration`; what is left goes on the next run.
  const report = await sendExtraUsage({ deadline: new Date(Date.now() + 240_000) });
  return Response.json(report ?? { reported: 0, pending: 0 });
}

export { notFound as POST, notFound as PUT, notFound as PATCH, notFound as DELETE };
