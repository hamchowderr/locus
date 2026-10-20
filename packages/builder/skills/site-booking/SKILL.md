---
name: site-booking
description: Use when a site should let visitors book a time (appointments, consultations, calls, classes). How to pick one of the client's calendars, the two ways to put booking on a page (the site's own booking UI or the CRM's booking widget), and what happens to a booking.
license: Proprietary (Otaku Solutions)
---

# Site booking

Bookings go into the client's own calendars in their CRM. Never invent a calendar, a booking
link or an embed code, and never use a third-party booking service: everything goes through
the `crm` tool.

## 1. Pick the calendar
- `crm` with action `calendars` lists the client's active calendars: `id`, `name`, `type` and
  `embedUrl` (the CRM's own booking page for it).
- One calendar: use it. Several: pick the one whose name fits the page (e.g. "Consultation"
  for a "Book a consultation" page), or ask the person which one in one short question.
- None: tell the person to create a calendar in their CRM first, and put a contact form
  (site-forms skill) on the page meanwhile.

## 2. Choose how it looks
Ask only if the person cares; otherwise use the site's own booking UI.

- **The site's own booking UI** (default): `crm` with action `add_booking` writes
  `components/booking.tsx`. Use it as `<Booking calendarId="<id>" />`, with an optional
  `form="consultation"` (the CRM tag "website form: <form>", lower case with dashes). It
  matches the site's theme, shows free days and times in the visitor's own timezone, then
  asks for name, email, optional phone and a note.
- **The CRM's booking widget**: `crm` with action `add_calendar_embed` writes
  `components/calendar-embed.tsx`. Use it as `<CalendarEmbed src="<embedUrl>" />`. It shows
  the calendar exactly as the CRM does (its own form questions, payments, confirmations), but
  in the CRM's look, inside a frame. Choose it when the calendar collects payment or asks
  custom questions the site's UI doesn't.

Both are server-safe client components; put them in a section with a clear heading
("Book a free consultation") and a sentence saying what happens next.

## What happens to a booking
- The visitor becomes a contact the same way a form lead does (matched by email or phone; an
  existing contact keeps its details and only its blank fields are filled), tagged
  "website lead" and "website form: booking" (or the `form` you passed), with a note.
- The time is booked on that calendar for that contact. The calendar's own rules apply
  (opening hours, notice, buffers), and its own confirmations and reminders go out.
- A time that was just taken is refused with a message; the UI shows the free times again.

## Rules
- Don't edit `components/booking.tsx`'s requests, `app/api/locus/[...path]/route.ts` or
  `lib/locus.ts`; Locus owns them. Style around the component instead, or pass props.
- In a draft or preview the times are samples and nothing is booked; say so if the person
  tries it. Bookings work once the site is published.
- Never put the calendar id anywhere else than the component's prop, and never put a key or
  token in the site.
