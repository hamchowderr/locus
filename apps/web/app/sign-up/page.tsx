import Link from "next/link";
import { safeNext } from "@/lib/next-path";
import { signUp } from "../actions";
import { AuthPage, Button, Field, Notice } from "../ui";

export default async function SignUp({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string; next?: string }>;
}) {
  const { error, sent, next } = await searchParams;
  if (sent) {
    return (
      <AuthPage title="Check your email">
        <Notice tone="info">
          We sent you a link to verify your address. Open it to finish signing up.
        </Notice>
      </AuthPage>
    );
  }
  return (
    <AuthPage title="Create your Locus account">
      {error && <Notice tone="error">{error}</Notice>}
      <form action={signUp} className="space-y-4">
        <input type="hidden" name="next" value={safeNext(next, "/onboarding")} />
        <Field label="Your name" name="name" required autoComplete="name" />
        <Field label="Work email" name="email" type="email" required autoComplete="email" />
        <Field
          label="Password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />
        <Button>Create account</Button>
      </form>
      <p className="text-sm text-neutral-600">
        Already have an account?{" "}
        <Link href="/sign-in" className="underline">
          Sign in
        </Link>
      </p>
    </AuthPage>
  );
}
