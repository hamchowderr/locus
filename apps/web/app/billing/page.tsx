import { agencyEntitlement, ClientAccessDenied, PLANS, requireAgencyManager } from "@locus/auth";
import { redirect } from "next/navigation";
import { billingEnabled, currentSession, locus, sessionContext } from "@/lib/locus";
import { openBillingPortal, subscribe } from "../actions";
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

export default async function Billing({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; subscribed?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fbilling");
  const organizationId = current.session.activeOrganizationId;
  if (!organizationId) redirect("/onboarding");
  const { error, subscribed } = await searchParams;
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

  return (
    <Page title="Billing">
      {error && <Notice tone="error">{error}</Notice>}
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
