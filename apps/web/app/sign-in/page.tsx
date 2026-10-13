import Link from "next/link";
import { safeNext } from "@/lib/next-path";
import { signIn } from "../actions";
import { Button, Field, Notice, Page } from "../ui";

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; reset?: string }>;
}) {
  const { error, next, reset } = await searchParams;
  return (
    <Page title="Sign in to Locus">
      {reset && <Notice tone="info">Your password is changed. Sign in with the new one.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <form action={signIn} className="space-y-4">
        <input type="hidden" name="next" value={safeNext(next, "/")} />
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
        <Link href="/forgot-password" className="underline">
          Forgot your password?
        </Link>
      </p>
      <p className="text-sm text-neutral-600">
        New to Locus?{" "}
        <Link href="/sign-up" className="underline">
          Create an account
        </Link>
      </p>
    </Page>
  );
}
