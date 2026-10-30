import { ClientAccessDenied, listAccessibleClients, TRIAL_DAYS } from "@locus/auth";
import { ONBOARDING_STEPS, type OnboardingStep } from "@locus/connect";
import { redirect } from "next/navigation";
import { connectMessage } from "@/lib/connect-messages";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { setupStepFor } from "@/lib/onboarding";
import { chooseMainClient, skipSetupStep } from "../actions";
import { AuthPage, Button, Notice } from "../ui";

const TITLES: Record<OnboardingStep, string> = {
  ghl: "Connect your GoHighLevel agency",
  main: "Pick your main sub-account",
  github: "Connect GitHub",
  vercel: "Connect Vercel",
};

const LINK =
  "block w-full rounded-md bg-neutral-900 px-4 py-2 text-center text-sm font-medium text-white";

/**
 * A new agency's setup, one step at a time: GoHighLevel (which creates and names the agency),
 * its main sub-account, GitHub, then Vercel. The step comes from what is connected, so leaving
 * and signing in again picks up where it stopped. Agencies past it (or from before it) go on to
 * the chat.
 */
export default async function Onboarding({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; refused?: string; reason?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fonboarding");
  const { error, refused, reason } = await searchParams;
  // Members who aren't owners or admins can't do the setup, so they go on to the chat.
  const step = await setupStepFor(current);
  if (!step) redirect("/chat");

  const number = ONBOARDING_STEPS.indexOf(step) + 1;
  return (
    <AuthPage title={TITLES[step]}>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        Step {number} of {ONBOARDING_STEPS.length}
      </p>
      {error && <Notice tone="error">{connectMessage(error)}</Notice>}
      {step === "ghl" && <ConnectGhl />}
      {step === "main" && (
        <PickMain
          clients={
            await listAccessibleClients(locus().db, sessionContext(current)).catch((e) => {
              if (e instanceof ClientAccessDenied) return [];
              throw e;
            })
          }
          waiting={refused && reason ? `${refused} more are waiting: ${reason}` : null}
        />
      )}
      {step === "github" && <ConnectGithub />}
      {step === "vercel" && <ConnectVercel />}
    </AuthPage>
  );
}

function ConnectGhl() {
  return (
    <>
      <p className="text-sm text-neutral-600">
        Approve Locus for your agency in GoHighLevel and choose the sub-accounts to bring in,
        including your own. Your Locus agency takes its name from GoHighLevel.
      </p>
      <p className="text-sm text-neutral-600">
        Your {TRIAL_DAYS}-day free trial starts here. No card needed.
      </p>
      <a href="/api/connect/crm/start" className={LINK}>
        Connect GoHighLevel
      </a>
    </>
  );
}

function PickMain({
  clients,
  waiting,
}: {
  clients: { id: string; name: string }[];
  waiting: string | null;
}) {
  if (clients.length === 0) {
    return (
      <>
        <Notice tone="info">
          No sub-accounts came across. In GoHighLevel's screen, choose at least your own
          sub-account, then connect again.
        </Notice>
        {waiting && (
          <>
            <Notice tone="info">{waiting}</Notice>
            <a href="/billing" className="block text-center text-sm underline">
              Choose a plan
            </a>
          </>
        )}
        <a href="/api/connect/crm/start" className={LINK}>
          Connect GoHighLevel again
        </a>
      </>
    );
  }
  return (
    <form action={chooseMainClient} className="space-y-4">
      <p className="text-sm text-neutral-600">
        Which one is your own business? Its chat opens first, and Locus fills its notes from your
        website. The others are there too, and you can switch between them any time.
      </p>
      {waiting && <Notice tone="info">{waiting}</Notice>}
      <div className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
        {clients.map((client, i) => (
          <label key={client.id} className="flex items-center gap-3 px-4 py-3 text-sm">
            <input
              type="radio"
              name="locationId"
              value={client.id}
              required
              defaultChecked={i === 0}
            />
            {client.name}
          </label>
        ))}
      </div>
      <Button>Continue</Button>
    </form>
  );
}

/** "Do this later", with what won't work until the step is done. */
function Later({ step, missing }: { step: "github" | "vercel"; missing: string }) {
  return (
    <form action={skipSetupStep} className="space-y-2 border-t border-neutral-200 pt-4">
      <input type="hidden" name="step" value={step} />
      <p className="text-sm text-neutral-600">{missing}</p>
      <p className="text-sm text-neutral-600">
        Chat, notes, threads, the inbox and connectors all work without it. You can connect it later
        from Integrations.
      </p>
      <button type="submit" className="text-sm underline">
        Do this later
      </button>
    </form>
  );
}

function ConnectGithub() {
  return (
    <>
      <p className="text-sm text-neutral-600">
        Every site, funnel and tool Locus builds is code in its own repository in your GitHub, so
        you own it. Install Locus on your GitHub organisation. On a personal account it can't create
        repositories.
      </p>
      <a href="/api/connect/github/start" className={LINK}>
        Connect GitHub
      </a>
      <Later
        step="github"
        missing="Until GitHub is connected, sites can be built and previewed in Locus but not published: there's nowhere to keep their code."
      />
    </>
  );
}

function ConnectVercel() {
  return (
    <>
      <p className="text-sm text-neutral-600">
        Sites go live on your own Vercel team. Choose the team they should deploy to.
      </p>
      <a href="/api/connect/vercel/start" className={LINK}>
        Connect Vercel
      </a>
      <Later
        step="vercel"
        missing="Until Vercel is connected, nothing goes live: no live sites, no custom domains, and no member logins or site databases."
      />
    </>
  );
}
