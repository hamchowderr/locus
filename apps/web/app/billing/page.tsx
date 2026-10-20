import {
  agencyEntitlement,
  ClientAccessDenied,
  CREDIT,
  OVERAGE_CENTS_PER_CREDIT,
  PLANS,
  requireAgencyManager,
  usageSummary,
} from "@locus/auth";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { sendExtraUsage } from "@/lib/extra-usage";
import { billingEnabled, currentSession, locus, sessionContext } from "@/lib/locus";
import { openBillingPortal, setExtraUsage, subscribe } from "../actions";
import { Notice, Page } from "../ui";

const STATUS: Record<string, string> = {
  comped: "Comped by this deployment's operator: full access, no payment.",
  active: "Active.",
  trialing: "On a free trial.",
  past_due:
    "Payment overdue. Existing clients keep working; you can't add new ones until it's paid.",
  unpaid: "Unpaid. Existing clients keep working; you can't add new ones until it's paid.",
  canceled: "Cancelled.",
  incomplete: "Checkout wasn't finished.",
  none: "No plan yet.",
};

const credits = (units: number) =>
  Math.round(units / CREDIT).toLocaleString("en-US", { maximumFractionDigits: 0 });
/** What a number of credit units costs as extra usage, in dollars. */
const dollarsOf = (units: number) => ((units / CREDIT) * OVERAGE_CENTS_PER_CREDIT) / 100;

export default async function Billing({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; subscribed?: string; saved?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fbilling");
  const organizationId = current.session.activeOrganizationId;
  if (!organizationId) redirect("/onboarding");
  const { error, subscribed, saved } = await searchParams;
  const { db } = locus();
  const entitlement = await agencyEntitlement(db, organizationId);
  const manager = await requireAgencyManager(db, sessionContext(current)).then(
    () => true,
    (e) => {
      if (e instanceof ClientAccessDenied) return false;
      throw e;
    },
  );
  const enabled = billingEnabled();
  const paying = entitlement.status !== "none" && entitlement.status !== "comped";
  const usage = manager && paying ? await usageSummary(locus().db, sessionContext(current)) : null;
  // Whatever extra usage is waiting goes to Stripe after the page is sent, not before.
  if (enabled && usage?.overage) after(() => sendExtraUsage(organizationId).then(() => undefined));

  return (
    <Page title="Billing">
      {error && <Notice tone="error">{error}</Notice>}
      {saved && <Notice tone="info">Extra usage saved.</Notice>}
      {subscribed && (
        <Notice tone="info">
          Thanks. Your plan shows here as soon as Stripe confirms the payment.
        </Notice>
      )}
      <p>
        {entitlement.plan && <strong>{entitlement.plan.title}. </strong>}
        {STATUS[entitlement.status]}
      </p>
      <p className="text-sm text-neutral-600">
        Agency ID: <span className="font-mono">{organizationId}</span>
      </p>

      {!enabled && entitlement.status !== "comped" && (
        <Notice tone="info">Billing isn't set up on this deployment, so nothing is limited.</Notice>
      )}
      {enabled && !manager && (
        <Notice tone="info">Only the agency's owners and admins manage billing.</Notice>
      )}

      {enabled && manager && entitlement.status !== "comped" && (
        <ul className="space-y-3">
          {PLANS.map((plan) => (
            <li key={plan.name} className="rounded-md border border-neutral-200 p-4 text-sm">
              <p className="font-medium">
                {plan.title} · ${plan.usdPerMonth}/month
              </p>
              <p className="text-neutral-600">
                {plan.limits.clients === null ? "Unlimited" : plan.limits.clients} clients ·{" "}
                {plan.limits.seats} seats
              </p>
              {entitlement.plan?.name === plan.name && paying ? (
                <p className="mt-2 text-neutral-600">Your plan.</p>
              ) : (
                <form action={subscribe} className="mt-2">
                  <input type="hidden" name="plan" value={plan.name} />
                  <button type="submit" className="underline">
                    {paying ? `Switch to ${plan.title}` : `Choose ${plan.title}`}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {enabled && usage && (
        <section className="space-y-2 rounded-md border border-neutral-200 p-4 text-sm">
          <h2 className="font-medium">AI credits this month</h2>
          {usage.agency && (
            <p>
              {credits(usage.agency.used)}
              {usage.agency.limit !== null && ` of ${credits(usage.agency.limit)}`} plan credits
              used.
              {usage.overage?.enabled &&
                ` ${credits(usage.overage.used)} extra credits used ($${dollarsOf(usage.overage.used).toFixed(2)} so far).`}
            </p>
          )}
          <p className="text-neutral-600">
            With extra usage on, AI keeps working after the plan's credits run out, up to your
            monthly limit. Extra credits cost ${(OVERAGE_CENTS_PER_CREDIT / 100).toFixed(2)} each
            and are added to your next Locus invoice. With it off, AI stops at the plan's credits.
          </p>
          <form action={setExtraUsage} className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={usage.overage?.enabled ?? false}
              />
              Extra usage on
            </label>
            <label className="flex items-center gap-2">
              Monthly limit $
              <input
                type="number"
                name="limitUsd"
                min={0}
                step={1}
                defaultValue={usage.overage ? Math.floor(dollarsOf(usage.overage.limit)) : 50}
                className="w-24 rounded border border-neutral-300 px-2 py-1"
              />
            </label>
            <button type="submit" className="underline">
              Save
            </button>
          </form>
        </section>
      )}

      {enabled && manager && paying && (
        <form action={openBillingPortal}>
          <button type="submit" className="text-sm underline">
            Manage payment details and invoices
          </button>
        </form>
      )}
    </Page>
  );
}
