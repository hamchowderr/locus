import Link from "next/link";
import { requestPasswordReset } from "../actions";
import { AuthPage, Button, Field, Notice } from "../ui";

export default async function ForgotPassword({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { sent } = await searchParams;
  if (sent) {
    return (
      <AuthPage title="Check your email">
        <Notice tone="info">
          If that address has a Locus account, we sent it a link to choose a new password. The link
          works once, for an hour.
        </Notice>
        <p className="text-sm text-neutral-600">
          <Link href="/sign-in" className="underline">
            Back to sign in
          </Link>
        </p>
      </AuthPage>
    );
  }
  return (
    <AuthPage title="Reset your password">
      <p className="text-sm text-neutral-600">
        Enter your account's email and we'll send you a link to choose a new password.
      </p>
      <form action={requestPasswordReset} className="space-y-4">
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        <Button>Send reset link</Button>
      </form>
      <p className="text-sm text-neutral-600">
        Remembered it?{" "}
        <Link href="/sign-in" className="underline">
          Sign in
        </Link>
      </p>
    </AuthPage>
  );
}
