import { TRIAL_DAYS } from "@locus/auth";
import Link from "next/link";
import { heldInstall } from "@/lib/ghl-install";
import { finishGhlInstall } from "../../actions";
import { AuthPage, Button, Notice } from "../../ui";

const NEXT = encodeURIComponent("/onboarding/install");

/**
 * The second way in: Locus installed from the GoHighLevel marketplace. GoHighLevel sends the
 * installer here with no Locus account or session, so the install waits (an hour) while they
 * sign up or sign in, then they confirm where it goes. From there it joins the usual setup at
 * "pick your main sub-account".
 */
export default async function GhlInstall() {
  const held = await heldInstall();

  if (held.kind === "none") {
    return (
      <AuthPage title="Nothing waiting to install">
        <Notice tone="info">
          There's no GoHighLevel install waiting in this browser, or it waited more than an hour.
          Install Locus again from the GoHighLevel marketplace, or sign in and connect from Locus.
        </Notice>
        <Link href="/" className="text-sm underline">
          Go to Locus
        </Link>
      </AuthPage>
    );
  }

  if (held.kind === "sign-in") {
    return (
      <AuthPage title={`Finish installing Locus for ${held.companyName}`}>
        <p className="text-sm text-neutral-600">
          GoHighLevel approved Locus. Create your Locus account, or sign in, to finish. Your{" "}
          {TRIAL_DAYS}-day free trial starts when you do. No card needed.
        </p>
        <Link
          href={`/sign-up?next=${NEXT}`}
          className="block w-full rounded-md bg-neutral-900 px-4 py-2 text-center text-sm font-medium text-white"
        >
          Create an account
        </Link>
        <p className="text-center text-sm text-neutral-600">
          Already have one?{" "}
          <Link href={`/sign-in?next=${NEXT}`} className="underline">
            Sign in
          </Link>
        </p>
      </AuthPage>
    );
  }

  if (held.kind === "taken") {
    return (
      <AuthPage title={`${held.companyName} is already in Locus`}>
        <Notice tone="info">
          This GoHighLevel agency is already connected to a Locus agency you're not part of. Ask its
          owner to invite you.
        </Notice>
      </AuthPage>
    );
  }

  return (
    <AuthPage title={`Finish installing Locus for ${held.companyName}`}>
      {held.join ? (
        <>
          <p className="text-sm text-neutral-600">
            Connect it to your Locus agency {held.join.name}. Its sub-accounts come across straight
            away.
          </p>
          <form action={finishGhlInstall}>
            <input type="hidden" name="choice" value="join" />
            <Button>Connect to {held.join.name}</Button>
          </form>
          <form action={finishGhlInstall} className="text-center">
            <input type="hidden" name="choice" value="new" />
            <button type="submit" className="text-sm underline">
              Start a new Locus agency for it instead
            </button>
          </form>
        </>
      ) : (
        <>
          <p className="text-sm text-neutral-600">
            Locus makes your agency, named {held.companyName}, brings in the sub-accounts you chose,
            and starts your {TRIAL_DAYS}-day free trial. No card needed.
          </p>
          <form action={finishGhlInstall}>
            <input type="hidden" name="choice" value="new" />
            <Button>Set up Locus</Button>
          </form>
        </>
      )}
    </AuthPage>
  );
}
