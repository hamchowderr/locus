---
name: site-checkout
description: Use when a site should sell something (a product, package, service or deposit) for a one-time price. How to pick one of the client's products and prices, put a buy button on a page, and what happens when a visitor buys.
license: Proprietary (Otaku Solutions)
---

# Site checkout

A site sells the client's own products from their CRM, paid through a CRM invoice. Never
invent a product, a price, an id or a payment link, and never use a third-party shop or
payment service: everything goes through the `crm` tool.

## 1. Pick the product and price
- `crm` with action `products` lists the client's products with their one-time prices, one
  line per price: `productId`, `priceId`, the product's and price's names, and the amount as
  the CRM lists it (e.g. `amount: 149.50 USD`).
- Pick the line whose product fits the page, or ask the person which one in one short
  question when several could.
- None: tell the person to add the product with a one-time price in their CRM (Payments →
  Products) first. Subscriptions (recurring prices) can't be sold from a site yet; say so and
  offer a contact form (site-forms skill) or a booking (site-booking skill) instead.

## 2. Put it on the page
- `crm` with action `add_checkout` writes `components/buy-button.tsx`. Use it as
  `<BuyButton productId="<productId>" priceId="<priceId>" />`, both ids copied from the
  `products` line and written out as text, with an optional `label="Book the deep clean"` and
  `form="deep-clean"` (the CRM tag "website form: <form>", lower case with dashes).
- The published site sells only the product and price pairs written out like that: Locus reads
  them from the code when the site is published. A button whose ids come from a variable or a
  list (`productId={item.id}`) sells nothing, so write one `<BuyButton>` per product.
- Show the product's name and price next to the button exactly as `products` lists them
  (e.g. "$149.50"). The page never sets the price: the invoice always charges the CRM's own
  price, so a price written differently on the page only misleads the visitor.
- Put it in a section or card with a clear heading and a sentence saying what happens next
  ("We'll email your invoice and take you to its secure payment page.").

## What happens when a visitor buys
- The button opens a short form: name, email and phone, all required (the CRM's invoice needs
  them).
- The visitor becomes a contact the same way a form lead does (matched by email; an existing
  contact keeps its details and only its blank fields are filled), tagged "website lead" and
  "website form: checkout" (or the `form` you passed), with a note saying what they started
  to buy.
- The CRM makes an invoice for that contact at the CRM's price and emails it, then the visitor
  is taken to the invoice's payment page to pay. The client sees the invoice and the payment in
  their CRM.
- If the payment page can't be opened from the site, the visitor is told the invoice was
  emailed and pays from the email instead.
- One email address is sent at most two invoices a day from a site, and a site at most 300.

## Rules
- Don't edit `components/buy-button.tsx`'s requests, `app/api/locus/[...path]/route.ts` or
  `lib/locus.ts`; Locus owns them. Style around the component instead, or pass props.
- In a draft or preview nothing is made or charged; the button says "Checkout works on the
  published site." Say so if the person tries it.
- Never put a product or price id anywhere else than the component's props, never write an
  amount into code that sends it anywhere, and never put a key or token in the site.
