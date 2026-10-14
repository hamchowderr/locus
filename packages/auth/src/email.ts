import type { SendEmail } from "./auth.ts";

/**
 * Picks how email is sent. Verification is mandatory, so local development must work without a
 * mail provider: `EMAIL_MODE=console` prints the message (and its link) to the server log.
 * `EMAIL_MODE=resend` sends through Resend with `RESEND_API_KEY` and `EMAIL_FROM`.
 *
 * Unset means console outside production and an error in production, and `console` is refused in
 * production too: a deployment must never print sign-in or reset links to its logs.
 */
export function emailFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): SendEmail {
  const production = env.NODE_ENV === "production";
  const mode = env.EMAIL_MODE ?? (production ? undefined : "console");
  if (mode === "console") {
    if (production) throw new Error("EMAIL_MODE=console is refused in production; use resend");
    return consoleEmail;
  }
  if (mode === "resend") {
    const apiKey = env.RESEND_API_KEY;
    const from = env.EMAIL_FROM;
    if (!apiKey || !from) throw new Error("EMAIL_MODE=resend needs RESEND_API_KEY and EMAIL_FROM");
    return resendEmail({ apiKey, from }, fetchImpl);
  }
  throw new Error(`EMAIL_MODE must be "console" or "resend" (got ${mode ?? "nothing"})`);
}

export const consoleEmail: SendEmail = async ({ to, subject, text }) => {
  console.info(`[email] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
};

export function resendEmail(
  config: { apiKey: string; from: string },
  fetchImpl: typeof fetch = fetch,
): SendEmail {
  return async ({ to, subject, text }) => {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.from, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`Resend refused the email: ${res.status} ${await res.text()}`);
  };
}
