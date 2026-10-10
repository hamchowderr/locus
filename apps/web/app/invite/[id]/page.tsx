import Link from "next/link";
import { currentSession } from "@/lib/locus";
import { acceptInvite } from "../../actions";
import { Button, Notice, Page } from "../../ui";

export default async function Invite({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const current = await currentSession();
  const here = `/invite/${encodeURIComponent(id)}`;
  if (!current) {
    return (
      <Page title="You're invited to Locus">
        <p className="text-neutral-600">
          Sign in, or create an account with the address the invitation was sent to.
        </p>
        <div className="flex gap-4 text-sm">
          <Link href={`/sign-in?next=${encodeURIComponent(here)}`} className="underline">
            Sign in
          </Link>
          <Link href={`/sign-up?next=${encodeURIComponent(here)}`} className="underline">
            Create an account
          </Link>
        </div>
      </Page>
    );
  }
  return (
    <Page title="Join the agency">
      <p className="text-neutral-600">You're signed in as {current.user.email}.</p>
      {error && <Notice tone="error">{error}</Notice>}
      <form action={acceptInvite}>
        <input type="hidden" name="invitationId" value={id} />
        <Button>Accept invitation</Button>
      </form>
    </Page>
  );
}
