---
name: site-forms
description: Use when adding or changing a form on a Locus site (contact, lead, quote, sign-up, newsletter). Where submissions go (the site's own /api/lead route), the fields and states a form needs, and why no key or token ever goes in the site's code.
license: Proprietary (Otaku Solutions)
---

# Site forms

## Where submissions go
- Every form posts to the site's own route, `/api/lead` (app/api/lead/route.ts). Locus
  connects that route to the client's CRM. Never post to a third-party form service, an
  external webhook or a CRM API from the browser.
- Never put API keys, tokens, webhook URLs with secrets, or any other credential in the site's
  code, in `NEXT_PUBLIC_` variables, or in lib/site.ts. Settings the site needs at run time
  come from the host's environment variables, read on the server only.
- The route accepts JSON. Keep its contract: an `email` field is required, other fields are
  passed through. If you change the route, keep validating on the server and return
  `{ ok: true }` or a 400 with `{ error }`.

## The existing form
components/lead-form.tsx (a client component) already does this: it collects the fields with
FormData, posts JSON to /api/lead and shows sending, sent and failed states. Reuse it, or copy
its pattern for a new form:
```tsx
const data = Object.fromEntries(new FormData(event.currentTarget));
const response = await fetch("/api/lead", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...data, form: "quote-request" }),
});
```
Add a hidden or extra `form` field to tell different forms apart.

## Fields
- Ask only for what the business will use. Name and email are the usual minimum; phone when
  they call back; a message box for enquiries.
- Use the shadcn components: Label + Input / Textarea, Button type="submit". Every field gets
  an `id`, a matching `<Label htmlFor>`, a `name`, the right `type` and
  `autoComplete`. Mark required fields with `required`.
- For choices, a native `<select>` styled like Input is fine; or write a shadcn Select
  component (see the shadcn skill; add it with add_dependency's `component`).

## States and validation
- Disable the submit button while sending and change its text ("Sending...").
- Success: replace the form with a short confirmation (`role="status"`), or redirect to a
  thank-you page in a funnel.
- Failure: keep what they typed and show a short message with `role="alert"`.
- Validate on the server too: the browser's checks are a convenience, not a guarantee.
- Consent text (e.g. "We'll only use your details to reply") goes near the button when the
  business needs it.
