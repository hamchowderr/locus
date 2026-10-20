import Link from "next/link";
import { redirect } from "next/navigation";
import { configured, currentSession } from "@/lib/locus";
import { AuthPage, Notice } from "./ui";

/**
 * The front door. Signed in, it opens the sub-account's chat (the Chat page sends you to
 * Sub-accounts when none is chosen yet); signed out, it offers sign-in and sign-up.
 */
export default async function Home() {
  const current = await currentSession();
  if (!configured()) {
    return (
      <AuthPage title="Locus">
        <Notice tone="info">Locus is being set up. Check back soon.</Notice>
      </AuthPage>
    );
  }
  if (current) redirect(current.session.activeOrganizationId ? "/chat" : "/onboarding");
  return (
    <AuthPage title="Operate every GoHighLevel client from one place">
      <div className="flex gap-4 text-sm">
        <Link href="/sign-in" className="underline">
          Sign in
        </Link>
        <Link href="/sign-up" className="underline">
          Create an account
        </Link>
      </div>
    </AuthPage>
  );
}
