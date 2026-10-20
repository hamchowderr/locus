import type { SiteFile } from "../workspace.ts";

// Selling one of the client's products from a site: `components/buy-button.tsx`, a button that
// opens a short form (name, email, phone), starts a checkout through the site's `/api/locus`
// route and sends the visitor on to the GHL invoice's payment page. Locus checks the product
// and price are the client's, takes the amount from GHL, adds the visitor as a contact and has
// GHL email them the invoice. No price, key or token is in the component; the page shows the
// price as text, as the builder's `crm` products lists it.
//
// The builder writes it into a site when the person wants to sell something (`crm` tool).

export const BUY_BUTTON_PATH = "components/buy-button.tsx";

/** The site's own buy button, for one of the client's products at one of its prices. */
export function buyButtonFile(): SiteFile {
  return {
    path: BUY_BUTTON_PATH,
    content: `"use client";

import { ShoppingCartIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

// Written by Locus. The checkout goes through the site's own /api/locus route to the client's
// CRM, which makes the invoice at its own price and emails it; the visitor then pays on the
// invoice's payment page. No key, token or price is here. In a draft or preview nothing is made.

export function BuyButton({
  productId,
  priceId,
  label = "Buy now",
  form = "checkout",
}: {
  productId: string;
  priceId: string;
  label?: string;
  form?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "preview" | "failed">("idle");
  const [error, setError] = useState("");
  const shownAt = useRef(Date.now());

  function start() {
    shownAt.current = Date.now();
    setState("idle");
    setError("");
    setOpen(true);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("sending");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/locus/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...data,
        productId,
        priceId,
        qty: 1,
        form,
        page: window.location.pathname,
        elapsedMs: Date.now() - shownAt.current,
      }),
    }).catch(() => null);
    const result = await response?.json().catch(() => null);
    if (response?.ok && result?.preview) return setState("preview");
    // Only ever on to an https payment page, as Locus checked it.
    const payUrl = result?.payUrl;
    if (response?.ok && typeof payUrl === "string" && payUrl.startsWith("https://")) {
      window.location.assign(payUrl);
      return;
    }
    setError(typeof result?.error === "string" ? result.error : "");
    setState("failed");
  }

  if (!open) {
    return (
      <Button type="button" size="lg" onClick={start}>
        <ShoppingCartIcon aria-hidden />
        {label}
      </Button>
    );
  }

  if (state === "preview") {
    return (
      <p role="status" className="rounded-lg bg-primary/10 p-4">
        Checkout works on the published site.
      </p>
    );
  }

  const id = \`buy-\${priceId}\`;
  return (
    <form onSubmit={submit} className="max-w-sm">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={\`\${id}-name\`}>Name</FieldLabel>
          <Input id={\`\${id}-name\`} name="name" required maxLength={120} autoComplete="name" />
        </Field>
        <Field>
          <FieldLabel htmlFor={\`\${id}-email\`}>Email</FieldLabel>
          <Input id={\`\${id}-email\`} name="email" type="email" required maxLength={254} autoComplete="email" />
        </Field>
        <Field>
          <FieldLabel htmlFor={\`\${id}-phone\`}>Phone</FieldLabel>
          <Input id={\`\${id}-phone\`} name="phone" type="tel" required maxLength={32} autoComplete="tel" />
        </Field>
        {/* Spam trap: hidden from people, filled in by bots. Keep it. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor={\`\${id}-fax\`}>Leave this empty</label>
          <input id={\`\${id}-fax\`} name="fax" type="text" tabIndex={-1} autoComplete="off" />
        </div>
        <Field>
          <Button type="submit" size="lg" disabled={state === "sending"}>
            {state === "sending" ? "Starting checkout…" : "Continue to payment"}
          </Button>
          <p className="text-sm text-muted-foreground">
            We'll email your invoice and take you to its secure payment page.
          </p>
          {state === "failed" && (
            <FieldError>{error || "That didn't go through. Please try again."}</FieldError>
          )}
        </Field>
      </FieldGroup>
    </form>
  );
}
`,
  };
}
