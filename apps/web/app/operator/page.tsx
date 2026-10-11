import { listAgencies, NotOperator, operatorsFromEnv } from "@locus/auth";
import { notFound, redirect } from "next/navigation";
import { currentSession, locus, sessionContext } from "@/lib/locus";
import { setAgencyComped } from "../actions";
import { Notice, Page } from "../ui";

/** The deployment's operator view: every agency, account-level only. Others get a 404. */
export default async function Operator({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Foperator");
  const { error } = await searchParams;
  const agencies = await listAgencies(
    locus().db,
    sessionContext(current),
    operatorsFromEnv(),
  ).catch((e) => {
    if (e instanceof NotOperator) notFound();
    throw e;
  });

  return (
    <Page title="Operator">
      {error && <Notice tone="error">{error}</Notice>}
      <p className="text-sm text-neutral-600">
        Every agency on this deployment. A comped agency has full access without paying.
      </p>
      <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
        {agencies.map((agency) => (
          <li key={agency.id} className="space-y-1 px-4 py-3 text-sm">
            <p className="font-medium">
              {agency.name}
              {agency.comped && (
                <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">
                  comped
                </span>
              )}
            </p>
            <p className="text-neutral-600">
              {agency.ownerEmails.join(", ") || "no owner"} · {agency.clients} clients · since{" "}
              {agency.createdAt.toISOString().slice(0, 10)}
            </p>
            <p className="font-mono text-xs text-neutral-500">{agency.id}</p>
            <form action={setAgencyComped}>
              <input type="hidden" name="organizationId" value={agency.id} />
              <input type="hidden" name="comped" value={agency.comped ? "false" : "true"} />
              <button type="submit" className="text-sm underline">
                {agency.comped ? "End comp" : "Comp this agency"}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </Page>
  );
}
