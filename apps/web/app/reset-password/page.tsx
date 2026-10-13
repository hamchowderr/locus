import Link from "next/link";
import { resetPassword } from "../actions";
import { Button, Field, Notice, Page } from "../ui";

/** Better Auth sends the emailed link here with `?token=`, or `?error=INVALID_TOKEN`. */
export default async function ResetPassword({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  if (!token || error === "INVALID_TOKEN") {
    return (
      <Page title="This link doesn't work">
        <Notice tone="error">
          The reset link has expired or was already used. Ask for a new one.
        </Notice>
        <p className="text-sm text-neutral-600">
          <Link href="/forgot-password" className="underline">
            Send a new reset link
          </Link>
        </p>
      </Page>
    );
  }
  return (
    <Page title="Choose a new password">
      {error && <Notice tone="error">{error}</Notice>}
      <form action={resetPassword} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <Field
          label="New password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />
        <Field
          label="Confirm new password"
          name="confirm"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />
        <Button>Set new password</Button>
      </form>
    </Page>
  );
}
