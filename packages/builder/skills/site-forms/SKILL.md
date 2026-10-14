---
name: site-forms
description: Use when adding or changing a form on a Locus site (contact, lead, quote, sign-up, newsletter). Where submissions go (the site's own /api/lead route, which forwards to Locus and the client's CRM), the fields and spam checks a form must send, and why no key or token ever goes in the site's code.
license: Proprietary (Otaku Solutions)
---

# Site forms

## Where submissions go
- Every form posts JSON to the site's own route, `/api/lead` (app/api/lead/route.ts). That route
  forwards the submission, server to server, to Locus, which puts it in the client's CRM: the
  contact is created or updated, tagged "website lead" and "website form: <form>", and the
  message and any extra answers are added as a note.
- Every site already has the route and `lib/locus.ts`. Don't edit, move or delete either:
  Locus rewrites `lib/locus.ts` with the site's endpoint each time the site is published. In a
  draft or preview it is null and the route answers `{ ok: true, preview: true }` without
  sending anything, so a test submission in the preview reaches no one.
- Never post to a third-party form service, an external webhook or a CRM API from the browser,
  and never write another route that does.
- Never put API keys, tokens, webhook URLs with secrets, or any other credential in the site's
  code, in `NEXT_PUBLIC_` variables, in lib/site.ts or in lib/locus.ts. The site needs none:
  Locus holds the CRM credentials.

## What a form sends
Locus accepts these fields, as text:
- `email` and/or `phone` — at least one is required. `name` (or `firstName` and `lastName`),
  `companyName` and `message` are optional.
- `form` — which form this is, lower case with dashes (`contact`, `quote-request`,
  `newsletter`). It becomes a tag in the CRM, so name each form for what it is.
- `page` — `window.location.pathname`.
- `fax` — the spam trap: an input hidden from people (off-screen, `aria-hidden`,
  `tabIndex={-1}`, `autoComplete="off"`). Bots fill it in; a filled one is dropped.
- `elapsedMs` — milliseconds from the form appearing to it being sent. Under three seconds is
  treated as a bot and dropped. Keep both checks in every form.
- Up to 10 other answers (e.g. `service`, `preferredDate`), names in letters, digits, `-` or
  `_`. They go into the note.

Limits: name 120 characters, email 254, phone 32, message 5000, other answers 1000, the whole
body 16 KB. Put matching `maxLength`s on the inputs. Never send `locationId`, `contactId`,
`tags`, `source` or `customFields`: Locus refuses a form that does.

## The existing form
components/lead-form.tsx (a client component) already does all of this. Reuse it, passing the
form's name — `<LeadForm form="quote-request" />` — or copy its pattern for a new form:
```tsx
const shownAt = useRef(Date.now());
// ...
const data = Object.fromEntries(new FormData(event.currentTarget));
const response = await fetch("/api/lead", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...data,
    form: "quote-request",
    page: window.location.pathname,
    elapsedMs: Date.now() - shownAt.current,
  }),
});
```
and keep the hidden trap inside the `<form>`:
```tsx
<div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
  <label htmlFor="quote-fax">Leave this empty</label>
  <input id="quote-fax" name="fax" type="text" tabIndex={-1} autoComplete="off" />
</div>
```

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
- Failure: keep what they typed and show the `error` the route returned (a short sentence
  written for the visitor), or a generic one, with `role="alert"`. A 429 means too many tries:
  say to try again later.
- Locus validates everything again; the browser's checks are a convenience, not a guarantee.
- Consent text (e.g. "We'll only use your details to reply") goes near the button when the
  business needs it.
