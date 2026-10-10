import { redirect } from "next/navigation";
import { currentSession } from "@/lib/locus";
import { createAgency } from "../actions";
import { Button, Field, Notice, Page } from "../ui";

export default async function Onboarding({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in");
  const { error } = await searchParams;
  return (
    <Page title="Name your agency">
      <p className="text-sm text-neutral-600">
        Your agency is where your team and your clients live in Locus.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <form action={createAgency} className="space-y-4">
        <Field label="Agency name" name="name" required maxLength={80} />
        <Button>Create agency</Button>
      </form>
    </Page>
  );
}
