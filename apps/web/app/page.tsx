import { ClientAccessDenied, isOperator, operatorsFromEnv, resolveActiveClient } from "@locus/auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { checkClientConnection } from "@/lib/connect";
import { configured, currentSession, locus, sessionContext } from "@/lib/locus";
import { signOut } from "./actions";
import { Notice, Page } from "./ui";

export default async function Home() {
  const current = await currentSession();
  if (!configured()) {
    return (
      <Page title="Locus">
        <Notice tone="info">Locus is being set up. Check back soon.</Notice>
      </Page>
    );
  }
  if (!current) {
    return (
      <Page title="Locus">
        <p className="text-neutral-600">Operate every GoHighLevel client from one place.</p>
        <div className="flex gap-4 text-sm">
          <Link href="/sign-in" className="underline">
            Sign in
          </Link>
          <Link href="/sign-up" className="underline">
            Create an account
          </Link>
        </div>
      </Page>
    );
  }
  if (!current.session.activeOrganizationId) redirect("/onboarding");

  const client = await resolveActiveClient(locus().db, sessionContext(current)).catch((error) => {
    if (error instanceof ClientAccessDenied) return null;
    throw error;
  });
  const ghl = client ? await checkClientConnection(client) : null;
  const operator = await isOperator(locus().db, sessionContext(current), operatorsFromEnv());
  return (
    <Page title="Locus">
      <p className="text-neutral-600">Signed in as {current.user.email}.</p>
      <p>
        {client ? (
          <>
            Working on <strong>{client.location.name}</strong>.{" "}
          </>
        ) : (
          "No client selected. "
        )}
        <Link href="/clients" className="underline">
          {client ? "Switch client" : "Choose a client"}
        </Link>
      </p>
      {ghl &&
        (ghl.ok ? (
          <Notice tone="info">GoHighLevel: connected to {ghl.name || "this sub-account"}.</Notice>
        ) : (
          <Notice tone="error">GoHighLevel: can't reach this client. {ghl.reason}</Notice>
        ))}
      <p>
        <Link href="/team" className="underline">
          Team
        </Link>{" "}
        ·{" "}
        <Link href="/connect" className="underline">
          GoHighLevel
        </Link>
        {operator && (
          <>
            {" "}
            ·{" "}
            <Link href="/operator" className="underline">
              Operator
            </Link>
          </>
        )}
      </p>
      <form action={signOut}>
        <button type="submit" className="text-sm underline">
          Sign out
        </button>
      </form>
    </Page>
  );
}
