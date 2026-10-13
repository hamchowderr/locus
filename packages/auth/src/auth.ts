import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import Stripe from "stripe";
import { mayManageBilling } from "./billing.ts";
import { PLANS } from "./plans.ts";

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
  /** Stripe, when the deployment bills. Without it billing is off and nothing calls Stripe. */
  billing?: { secretKey: string; webhookSecret: string } | undefined;
}

// Without billing the plugin still loads, so the schema and the API's types are the same
// everywhere, but it has no working key and no webhook secret: the webhook refuses everything,
// and the web app never offers checkout. Its organisation hooks only call Stripe for an agency
// that already has a Stripe customer, which an unbilled deployment never creates.
/** At most this many reset emails per account per window; extra requests are dropped quietly. */
const RESET_EMAILS_PER_WINDOW = 3;
const RESET_WINDOW_MS = 60 * 60 * 1000;

const NO_STRIPE = { secretKey: "sk_test_billing_is_off", webhookSecret: "" };

/**
 * Better Auth for Locus: email and password, agencies as organisations.
 *
 * Email verification is mandatory, both at sign-in and before acting on an invitation
 * (advisory GHSA-fmh4-wcc4-5jm3). Don't turn either off: an unverified address must never
 * be able to join an agency.
 */
export function createAuth(config: LocusAuthConfig) {
  const { sendEmail } = config;
  const auth = betterAuth({
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
    // A new session starts in the agency the user joined first, so signing in (again, or after
    // a password reset) never sends an existing member to create their agency a second time.
    // Someone with no agency yet still gets onboarding.
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            if (session.activeOrganizationId) return;
            const context = await auth.$context;
            const [first] = (await context.adapter.findMany({
              model: "member",
              where: [{ field: "userId", value: session.userId }],
              sortBy: { field: "createdAt", direction: "asc" },
              limit: 1,
            })) as { organizationId: string }[];
            if (!first) return;
            return { data: { ...session, activeOrganizationId: first.organizationId } };
          },
        },
      },
    },
    // Better Auth logs and swallows a failed verification email, so a sign-up whose email never
    // arrived still leaves an unverified account behind. Both ways back in resend the link:
    // signing up again with the same address, and signing in with the right password.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      // Sign-up answers the same whether or not the address exists, so this must not say which:
      // an unverified owner gets a fresh link, a verified one gets nothing.
      onExistingUserSignUp: async ({ user }) => {
        if (user.emailVerified) return;
        await auth.api.sendVerificationEmail({ body: { email: user.email } });
      },
      // The request answers the same whether or not the address exists; only an owner gets mail.
      // The link lasts an hour, works once, and signs every device out when it is used.
      sendResetPassword: async ({ user, url }) => {
        // Better Auth's rate limiter only guards HTTP calls, and the web app calls the API
        // directly from a server action, so cap the mail per address here. Each request leaves
        // a verification row (this one included), and the database is shared by every instance.
        const context = await auth.$context;
        const recent = await context.adapter.count({
          model: "verification",
          where: [
            { field: "value", value: user.id },
            { field: "identifier", operator: "starts_with", value: "reset-password:" },
            { field: "createdAt", operator: "gt", value: new Date(Date.now() - RESET_WINDOW_MS) },
          ],
        });
        if (recent > RESET_EMAILS_PER_WINDOW) {
          console.warn("Password reset email skipped: too many requests for one account");
          return;
        }
        await sendEmail({
          to: user.email,
          subject: "Reset your Locus password",
          text: `Open this link within an hour to choose a new password: ${url}\n\nIf you didn't ask for this, ignore this email; your password stays the same.`,
        });
      },
      revokeSessionsOnPasswordReset: true,
      // Using the link proves the owner reads that inbox, as a verification link would, so an
      // owner whose verification email never arrived is not left locked out after resetting.
      onPasswordReset: async ({ user }) => {
        if (user.emailVerified) return;
        const context = await auth.$context;
        await context.internalAdapter.updateUser(user.id, { emailVerified: true });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      // Opening the link proves the address, so sign the user straight in.
      autoSignInAfterVerification: true,
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
      stripe({
        stripeClient: new Stripe((config.billing ?? NO_STRIPE).secretKey),
        stripeWebhookSecret: (config.billing ?? NO_STRIPE).webhookSecret,
        // Otaku bills the agency, never a person: customers are organisations.
        organization: { enabled: true },
        subscription: {
          enabled: true,
          requireEmailVerification: true,
          plans: PLANS.map((p) => ({
            name: p.name,
            lookupKey: p.lookupKey,
            limits: { ...p.limits },
          })),
          // The agency comes from the session: the caller's referenceId must be the session's
          // active organisation, and only its owners and admins manage billing.
          authorizeReference: async ({ user, session, referenceId }, ctx) => {
            const row = await ctx.context.adapter.findOne<{ role: string }>({
              model: "member",
              where: [
                { field: "userId", value: user.id },
                { field: "organizationId", value: referenceId },
              ],
            });
            return mayManageBilling(row, session.activeOrganizationId, referenceId);
          },
        },
      }),
      // Lets Next.js server actions set the session cookie. Must stay last. Outside Next.js it
      // is inert: loading next/headers fails and the plugin skips itself.
      nextCookies(),
    ],
  });
  return auth;
}

export type LocusAuth = ReturnType<typeof createAuth>;
