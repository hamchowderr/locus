import type { SiteFile } from "../workspace.ts";

// Booking on a site, two ways:
//
// - `components/booking.tsx`: the site's own booking UI. It reads free times and books through
//   the site's `/api/locus` route (Locus checks the calendar is the client's, adds the visitor
//   as a contact and books the time in GHL). Looks like the rest of the site.
// - `components/calendar-embed.tsx`: GHL's own booking widget in an iframe. Everything GHL's
//   calendar does (forms, payments, confirmations) with no code, but it looks like GHL.
//
// The builder writes either one into a site when the person wants booking (`crm` tool).

export const BOOKING_COMPONENT_PATH = "components/booking.tsx";

/**
 * The calendars a site's code books on: each `calendarId="…"` written as a literal on a
 * `<Booking>`. Locus reads them at publish and accepts bookings on those calendars only.
 */
export function bookingCalendarIds(files: { path: string; content: string | Uint8Array }[]) {
  const ids = new Set<string>();
  for (const file of files) {
    if (typeof file.content !== "string" || !/\.(tsx|jsx)$/.test(file.path)) continue;
    for (const tag of file.content.matchAll(/<Booking\b[^>]*>/g)) {
      const id = tag[0].match(/\bcalendarId=(?:\{\s*)?["'`]([A-Za-z0-9]{1,64})["'`]/)?.[1];
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}
export const CALENDAR_EMBED_PATH = "components/calendar-embed.tsx";

/** The site's own booking UI, for one of the client's calendars. */
export function bookingComponentFile(): SiteFile {
  return {
    path: BOOKING_COMPONENT_PATH,
    content: `"use client";

import { CalendarCheckIcon, CheckIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// Written by Locus. Free times and bookings go through the site's own /api/locus route to
// the client's calendar; no key or token is here. In a draft or preview the times are samples
// and nothing is booked.

type Day = { date: string; slots: string[] };
const DAYS = 7;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
/** Today where the visitor is, as the calendar's days are keyed. */
const today = (timezone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

export function Booking({ calendarId, form = "booking" }: { calendarId: string; form?: string }) {
  // The visitor's timezone is only known in their browser, so the times load after the page
  // has rendered there (the server's render shows "Loading times…").
  const [timezone, setTimezone] = useState<string | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [days, setDays] = useState<Day[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "booked" | "failed">("idle");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    setTimezone(zone);
    setStart(today(zone));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: \`reload\` asks for the times again
  useEffect(() => {
    if (!timezone || !start) return;
    let live = true;
    setDays(null);
    setLoadError("");
    const query = new URLSearchParams({ calendarId, start, days: String(DAYS), timezone });
    fetch(\`/api/locus/booking/slots?\${query}\`)
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (!live) return;
        if (!response.ok) {
          setLoadError(typeof result?.error === "string" ? result.error : "Times didn't load.");
          setDays([]);
          return;
        }
        const found: Day[] = (result?.days ?? []).filter((d: Day) => d.slots.length > 0);
        setDays(found);
        setDay(found[0]?.date ?? null);
      })
      .catch(() => live && (setLoadError("Times didn't load. Please try again."), setDays([])));
    return () => {
      live = false;
    };
  }, [calendarId, start, timezone, reload]);

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  const dayLabel = (date: string) =>
    new Date(\`\${date}T12:00:00Z\`).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const pick = (next: string | null) => {
    setSlot(next);
    setState("idle");
    setError("");
  };
  const move = (by: number) => {
    if (!start || !timezone) return;
    const next = new Date(\`\${start}T00:00:00Z\`);
    next.setUTCDate(next.getUTCDate() + by * DAYS);
    const day = isoDay(next) < today(timezone) ? today(timezone) : isoDay(next);
    pick(null);
    setStart(day);
  };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!slot) return;
    setState("sending");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/locus/booking", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...data,
        calendarId,
        startTime: slot,
        timezone: timezone ?? "UTC",
        form,
        page: window.location.pathname,
        elapsedMs: Date.now() - shownAt.current,
      }),
    }).catch(() => null);
    if (response?.ok) return setState("booked");
    const result = await response?.json().catch(() => null);
    setError(typeof result?.error === "string" ? result.error : "");
    setState("failed");
    // A time that was just taken: offer the others again.
    if (response?.status === 409) {
      setSlot(null);
      setReload((n) => n + 1);
    }
  }

  if (state === "booked" && slot) {
    return (
      <p role="status" className="flex items-center gap-3 rounded-lg bg-primary/10 p-6">
        <CheckIcon className="size-5 text-primary" aria-hidden />
        You're booked for {dayLabel(slot.slice(0, 10))} at {time(slot)}. We'll send a confirmation.
      </p>
    );
  }

  const current = days?.find((d) => d.date === day);
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => move(-1)} disabled={!start || !timezone || start <= today(timezone)}>
          Earlier
        </Button>
        <p className="text-sm text-muted-foreground">{timezone && \`Times shown in \${timezone}\`}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => move(1)}>
          Later
        </Button>
      </div>
      {state === "failed" && !slot && error && (
        <p role="alert" className="text-destructive">{error}</p>
      )}
      {days === null ? (
        <p className="text-muted-foreground" role="status">Loading times…</p>
      ) : days.length === 0 ? (
        <p className="text-muted-foreground" role="status">
          {loadError || "No times are free these days. Try later dates."}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Day">
            {days.map((d) => (
              <Button
                key={d.date}
                type="button"
                variant={d.date === day ? "default" : "outline"}
                aria-pressed={d.date === day}
                onClick={() => (setDay(d.date), pick(null))}
              >
                {dayLabel(d.date)}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Time">
            {current?.slots.map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant={s === slot ? "default" : "secondary"}
                aria-pressed={s === slot}
                onClick={() => pick(s)}
              >
                {time(s)}
              </Button>
            ))}
          </div>
        </>
      )}
      {slot && (
        <form onSubmit={submit}>
          <FieldGroup>
            <p className="flex items-center gap-2 font-medium">
              <CalendarCheckIcon className="size-4 text-primary" aria-hidden />
              {dayLabel(slot.slice(0, 10))} at {time(slot)}
            </p>
            <Field>
              <FieldLabel htmlFor="booking-name">Name</FieldLabel>
              <Input id="booking-name" name="name" required maxLength={120} autoComplete="name" />
            </Field>
            <Field>
              <FieldLabel htmlFor="booking-email">Email</FieldLabel>
              <Input id="booking-email" name="email" type="email" required maxLength={254} autoComplete="email" />
            </Field>
            <Field>
              <FieldLabel htmlFor="booking-phone">Phone (optional)</FieldLabel>
              <Input id="booking-phone" name="phone" type="tel" maxLength={32} autoComplete="tel" />
            </Field>
            <Field>
              <FieldLabel htmlFor="booking-message">Anything we should know? (optional)</FieldLabel>
              <Textarea id="booking-message" name="message" rows={3} maxLength={5000} />
            </Field>
            {/* Spam trap: hidden from people, filled in by bots. Keep it. */}
            <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor="booking-fax">Leave this empty</label>
              <input id="booking-fax" name="fax" type="text" tabIndex={-1} autoComplete="off" />
            </div>
            <Field>
              <Button type="submit" size="lg" disabled={state === "sending"}>
                {state === "sending" ? "Booking…" : "Book this time"}
              </Button>
              {state === "failed" && (
                <FieldError>{error || "That didn't book. Please try again."}</FieldError>
              )}
            </Field>
          </FieldGroup>
        </form>
      )}
    </div>
  );
}
`,
  };
}

/**
 * GHL's own booking widget for one calendar. `src` is the calendar's booking page from the
 * builder's `crm` tool; only GHL's widget addresses are accepted, so the frame can't be pointed
 * anywhere else.
 */
export function calendarEmbedFile(): SiteFile {
  return {
    path: CALENDAR_EMBED_PATH,
    content: `// Written by Locus. GHL's own booking widget for one of the client's calendars.

const WIDGET = /^https:\\/\\/(api\\.leadconnectorhq\\.com|link\\.msgsndr\\.com)\\/widget\\/booking\\/[A-Za-z0-9]{1,64}$/;

export function CalendarEmbed({
  src,
  title = "Book a time",
  height = 760,
}: {
  src: string;
  title?: string;
  height?: number;
}) {
  if (!WIDGET.test(src)) return null;
  return (
    <iframe
      src={src}
      title={title}
      loading="lazy"
      className="w-full rounded-lg border-0"
      style={{ height }}
      scrolling="no"
    />
  );
}
`,
  };
}
