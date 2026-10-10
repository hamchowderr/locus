import Link from "next/link";
import { signIn } from "../actions";
import { Button, Field, Notice, Page } from "../ui";

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <Page title="Sign in to Locus">
      {error && <Notice tone="error">{error}</Notice>}
      <form action={signIn} className="space-y-4">
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        <Field
          label="Password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
        <Button>Sign in</Button>
      </form>
      <p className="text-sm text-neutral-600">
        New to Locus?{" "}
        <Link href="/sign-up" className="underline">
          Create an account
        </Link>
      </p>
    </Page>
  );
}
