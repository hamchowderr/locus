/** What the integrations' callbacks report back as `?error=`, in words for the person. */
const MESSAGES: Record<string, string> = {
  state: "That sign-in to GoHighLevel expired or didn't match. Try again.",
  ghl: "GoHighLevel refused the connection. Try again.",
  "not-configured": "GoHighLevel isn't set up on this deployment yet.",
  "github-state": "That GitHub install expired or didn't start from Locus. Try again from here.",
  "github-not-configured": "GitHub isn't set up on this deployment yet.",
  "vercel-state": "That Vercel install expired or didn't start from Locus. Try again from here.",
  "vercel-not-configured": "Vercel isn't set up on this deployment yet.",
};

/** The words for a callback's `error`: a known code, or the message it carried. */
export const connectMessage = (error: string) => MESSAGES[error] ?? error;
