import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

/** Sends one email. `EMAIL_MODE=console` logs it; `resend` sends it. */
export type SendEmail = (message: { to: string; subject: string; text: string }) => Promise<void>;

export interface LocusAuthConfig {
  /** A Drizzle database over the control DB. */
  db: Parameters<typeof drizzleAdapter>[0];
  /** The Drizzle schema, so the adapter maps Better Auth's models to our tables. */
  schema?: Record<string, unknown>;
  baseURL: string;
  secret: string;
  sendEmail: SendEmail;
}

/**
 * Better Auth for Locus: email and password, agencies as organisations.
 *
 * Email verification is mandatory, both at sign-in and before acting on an invitation
 * (advisory GHSA-fmh4-wcc4-5jm3). Don't turn either off: an unverified address must never
 * be able to join an agency.
 */
export function createAuth(config: LocusAuthConfig) {
  const { sendEmail } = config;
  return betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    database: drizzleAdapter(config.db, { provider: "sqlite", schema: config.schema }),
    session: {
      additionalFields: {
        // The client this session works on. Only `selectClient` sets it, after the access
        // check; every use re-checks it (`resolveActiveClient`). Never settable from a request.
        activeLocationId: { type: "string", required: false, input: false },
      },
    },
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail({
          to: user.email,
          subject: "Verify your email for Locus",
          text: `Open this link to verify your email: ${url}`,
        });
      },
    },
    plugins: [
      organization({
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail: async ({ id, email, organization: agency }) => {
          await sendEmail({
            to: email,
            subject: `You're invited to ${agency.name} on Locus`,
            text: `Accept the invitation: ${config.baseURL}/invite/${id}`,
          });
        },
      }),
    ],
  });
}

export type LocusAuth = ReturnType<typeof createAuth>;
