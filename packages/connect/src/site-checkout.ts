import { GhlError, ghlRequest } from "@locus/ghl";
import { operationById } from "@locus/skills";
import {
  consumeSiteLimits,
  countWithDeadline,
  type LeadContact,
  logGhlFailure,
  MAX_LEAD_BODY_BYTES,
  parseLead,
  publishedSite,
  type SiteGhl,
  type SiteLeadDeps,
  sendToGhl,
  siteGhl,
} from "./site-leads.ts";

// Selling one of the client's GHL products from a published site, paid through a GHL invoice.
//
//   browser → the site's own /api/locus/checkout (same origin) → Locus
//   /api/sites/<siteId>/checkout
//
// The visitor names a product and one of its prices (the ids the builder wrote into the site's
// `<BuyButton>`) and says who they are. As with forms and booking, the client is read from the
// site's registry row, never from the request, and no token reaches the site. Everything about
// the sale comes from GHL, never from the request: the product and price are read with the
// client's own session and checked against that sub-account (the product is this client's, the
// price is that product's), and the amount and currency on the invoice are the price's. A
// request that says an amount says nothing GHL ever hears.
//
// A checkout is also a lead: the contact goes through the same path as a form (found or created
// by email, only blank fields filled, tagged, noted). Then GHL makes an invoice for that contact
// and emails it (text2pay with `action: "send"`, to the email only: a text message costs the
// client money and a visitor's phone number is only what they typed). The visitor is sent on to
// the invoice's own payment page, where GHL's payment provider takes the money; Locus never sees
// a card. Whether it is a real charge or a test one is the deployment's `liveMode`, never the
// request's.
//
// Only one-time prices are sold for now: a recurring price would need GHL's recurring invoices,
// with their own schedule and consent.

/** Limits for starting a checkout: a little tighter than booking, as each makes an invoice. */
export const CHECKOUT_LIMITS = {
  perSite: { max: 100, windowMs: 60 * 60_000 },
  perSiteBurst: { max: 10, windowMs: 60_000 },
  perIp: { max: 5, windowMs: 10 * 60_000 },
  minFillMs: 3_000,
};

/** The most of one price a single checkout may buy. */
export const MAX_CHECKOUT_QTY = 10;

const GHL_ID = /^[A-Za-z0-9]{1,64}$/;

/**
 * The hosts a GHL invoice's payment page may be on. GHL's docs give no example `invoiceUrl`, so
 * these are GHL's own domains (its API and widget host, its link host, its client portal); an
 * agency's white-label domain is refused until a live account shows what GHL really returns.
 */
const PAY_HOSTS = ["leadconnectorhq.com", "msgsndr.com", "clientclub.net"];

/** Fields that would set the sale's terms. Ignored: the terms are GHL's, never the request's. */
const TERMS_FIELDS = ["amount", "price", "currency", "total", "liveMode", "type"];

const NOT_CONNECTED = "Checkout isn't connected on this site.";
const NOT_FOR_SALE = "That isn't for sale here.";
const NOT_STARTED = "We couldn't start the checkout just now. Please try again.";

export type SiteCheckoutResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404 | 413 | 422 | 502; body: { error: string } }
  | { status: 429; body: { error: string }; retryAfterSeconds: number };

const refuse = (status: 400 | 404 | 413 | 422 | 502, error: string): SiteCheckoutResult => ({
  status,
  body: { error },
});

/** What a checkout needs besides what a lead does. */
export type SiteCheckoutDeps = SiteLeadDeps & {
  /**
   * Whether invoices take real money. From the deployment (`LOCUS_GHL_LIVE_PAYMENTS`), never
   * from the request; false makes test-mode invoices.
   */
  liveMode: boolean;
};

export interface CheckoutInput {
  siteId: string;
  /** The request body as text, at most `MAX_LEAD_BODY_BYTES`. */
  raw: string;
  visitorIp: string | null;
}

function operation(id: string) {
  const op = operationById(id);
  if (!op) throw new Error(`The skill catalog is missing ${id}`);
  return op;
}

/** Whether an invoice's payment page is one of GHL's own https addresses. */
export function isGhlPayUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_000) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PAY_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** One line of the client's own text: no line breaks or column bars, capped. */
export const oneLine = (value: string, max = 120) =>
  value
    .replace(/[\s|]+/g, " ")
    .trim()
    .slice(0, max);

/** An amount as a person reads it: two decimals. */
export const amountText = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;

interface GhlProduct {
  _id?: string;
  locationId?: string;
  name?: string;
}

interface GhlPrice {
  _id?: string;
  locationId?: string;
  product?: string;
  name?: string;
  type?: string;
  currency?: string;
  amount?: number;
  trackInventory?: boolean;
  availableQuantity?: number;
  allowOutOfStockPurchases?: boolean;
}

/** What is being sold, as GHL has it. */
interface Sale {
  productId: string;
  priceId: string;
  productName: string;
  amount: number;
  currency: string;
  qty: number;
}

/** GHL's "no such product or price" (it answers 400 "Product not found"); anything else throws. */
async function orNotFound<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof GhlError && [400, 404, 422].includes(error.status)) return null;
    throw error;
  }
}

/**
 * The product and price, only when the product is this client's and the price is one of that
 * product's, a one-time price with a real amount. A refusal is a visitor-facing message.
 */
async function sellable(
  ghl: SiteGhl,
  productId: string,
  priceId: string,
  qty: number,
): Promise<Sale | { refused: string }> {
  const product = await orNotFound(() =>
    ghlRequest<GhlProduct>(
      operation("products.get-product-by-id"),
      ghl.session,
      { path: { productId } },
      ghl.options,
    ),
  );
  // GHL also finds a product by its slug: only its own id counts.
  if (product?._id !== productId || product.locationId !== ghl.session.locationId) {
    return { refused: NOT_FOR_SALE };
  }
  // Read through the product's own path, then checked to be that product's.
  const price = await orNotFound(() =>
    ghlRequest<GhlPrice>(
      operation("products.get-price-by-id-for-product"),
      ghl.session,
      { path: { productId, priceId } },
      ghl.options,
    ),
  );
  if (price?._id !== priceId || price.product !== productId) return { refused: NOT_FOR_SALE };
  if (price.locationId !== undefined && price.locationId !== ghl.session.locationId) {
    return { refused: NOT_FOR_SALE };
  }
  if (price.type !== "one_time") {
    return { refused: "That's a subscription, which can't be bought here yet." };
  }
  const { amount, currency } = price;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { refused: NOT_FOR_SALE };
  }
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    return { refused: NOT_FOR_SALE };
  }
  if (
    price.trackInventory === true &&
    price.allowOutOfStockPurchases !== true &&
    typeof price.availableQuantity === "number" &&
    price.availableQuantity < qty
  ) {
    return { refused: "There aren't enough of those left." };
  }
  const productName = oneLine(typeof product.name === "string" ? product.name : "") || "Product";
  return { productId, priceId, productName, amount, currency, qty };
}

/** The user GHL says made the invoice: the sub-account's first user, or null when it has none. */
async function invoicingUser(ghl: SiteGhl): Promise<string | null> {
  const found = await ghlRequest<{ users?: { id?: unknown; deleted?: unknown }[] }>(
    operation("users.search-users"),
    ghl.session,
    { query: { limit: "10" } },
    ghl.options,
  );
  const user = (found.users ?? []).find(
    (u) => typeof u.id === "string" && GHL_ID.test(u.id) && u.deleted !== true,
  );
  return (user?.id as string | undefined) ?? null;
}

/** The invoice, made and emailed by GHL; its number and payment page. */
async function invoiceFor(
  ghl: SiteGhl,
  sale: Sale,
  contactId: string,
  contact: LeadContact,
  email: string,
  userId: string,
  liveMode: boolean,
  now: number,
): Promise<{ number: string; url: unknown }> {
  const today = new Date(now).toISOString().slice(0, 10);
  const created = await ghlRequest<{
    invoice?: { _id?: string; invoiceNumber?: number | string };
    invoiceUrl?: unknown;
  }>(
    operation("invoices.text-2-pay-invoice"),
    ghl.session,
    {
      body: {
        name: sale.productName,
        currency: sale.currency,
        items: [
          {
            name: sale.productName,
            productId: sale.productId,
            priceId: sale.priceId,
            currency: sale.currency,
            amount: sale.amount,
            qty: sale.qty,
            type: "one_time",
          },
        ],
        contactDetails: {
          id: contactId,
          name: contact.name,
          phoneNo: contact.phone,
          email: contact.email || email,
        },
        issueDate: today,
        dueDate: today,
        // Email only: a text message costs the client money.
        sentTo: { email: [email] },
        liveMode,
        action: "send",
        userId,
      },
    },
    ghl.options,
  );
  const id = created.invoice?._id;
  if (typeof id !== "string" || !id) throw new Error("GoHighLevel's invoice response had no id");
  const number = created.invoice?.invoiceNumber;
  return {
    number:
      typeof number === "number" || typeof number === "string" ? oneLine(String(number), 40) : id,
    url: created.invoiceUrl,
  };
}

/**
 * Starts a checkout for one of the site's client's products: the visitor goes in as a lead (form
 * `checkout` unless the site names one), GHL makes and emails the invoice, and the answer is the
 * invoice's payment page.
 */
export async function startSiteCheckout(
  deps: SiteCheckoutDeps,
  input: CheckoutInput,
): Promise<SiteCheckoutResult> {
  if (Buffer.byteLength(input.raw) > MAX_LEAD_BODY_BYTES) {
    return refuse(413, "That's too much to send.");
  }
  let body: unknown;
  try {
    body = JSON.parse(input.raw);
  } catch {
    return refuse(400, "That checkout didn't send anything we could read.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refuse(400, "That checkout didn't send anything we could read.");
  }
  const { productId, priceId, qty: rawQty, ...rest } = body as Record<string, unknown>;
  for (const field of TERMS_FIELDS) delete rest[field];
  if (typeof productId !== "string" || !GHL_ID.test(productId)) return refuse(422, NOT_FOR_SALE);
  if (typeof priceId !== "string" || !GHL_ID.test(priceId)) return refuse(422, NOT_FOR_SALE);
  const qty =
    rawQty === undefined
      ? 1
      : typeof rawQty === "number" || (typeof rawQty === "string" && /^\d{1,2}$/.test(rawQty))
        ? Number(rawQty)
        : Number.NaN;
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_CHECKOUT_QTY) {
    return refuse(422, `Choose a quantity from 1 to ${MAX_CHECKOUT_QTY}.`);
  }
  const parsed = parseLead({ form: "checkout", ...rest });
  if ("error" in parsed) return refuse(422, parsed.error);
  const { lead, honeypot, elapsedMs } = parsed;
  // GHL's invoice needs all three.
  const { name, firstName, email, phone } = lead.fields;
  if (!(name || firstName) || !email || !phone) {
    return refuse(422, "Please enter your name, email and phone.");
  }

  const row = await publishedSite(deps.db, input.siteId);
  if (!row) return refuse(404, NOT_CONNECTED);
  // A bot: nothing is made, and it learns nothing.
  if (honeypot || elapsedMs === null || elapsedMs < CHECKOUT_LIMITS.minFillMs) {
    return { status: 200, body: { ok: true } };
  }
  const now = deps.now?.() ?? Date.now();
  const limited = await consumeSiteLimits(
    deps,
    row.site.id,
    input.visitorIp,
    CHECKOUT_LIMITS,
    now,
    "checkout",
  );
  if (limited !== null) {
    return {
      status: 429,
      body: { error: "Too many tries from here. Please try again later." },
      retryAfterSeconds: limited,
    };
  }

  // What is sold and who invoices it, before anything is written to the CRM.
  let ghl: SiteGhl;
  let sale: Sale;
  let userId: string | null;
  try {
    ghl = await siteGhl(deps, row.location);
    const found = await sellable(ghl, productId, priceId, qty);
    if ("refused" in found) return refuse(422, found.refused);
    sale = found;
    userId = await invoicingUser(ghl);
  } catch (error) {
    logGhlFailure(`Checkout check for site ${row.site.id}`, error);
    return refuse(502, NOT_STARTED);
  }
  if (!userId) {
    console.error(`Checkout for site ${row.site.id} failed: the sub-account has no user`);
    return refuse(502, "Checkout isn't set up for this site yet. Please contact us instead.");
  }

  // The contact first, then the invoice, then the note, which says what really happened: a
  // contact whose invoice couldn't be made gets a note saying nothing was charged.
  const what = `${sale.productName} × ${sale.qty} (${amountText(sale.amount, sale.currency)}${sale.qty > 1 ? " each" : ""})`;
  const done: { invoice?: { number: string; url: unknown }; failure?: unknown } = {};
  try {
    await sendToGhl(ghl, lead, async (contactId, contact) => {
      try {
        done.invoice = await invoiceFor(
          ghl,
          sale,
          contactId,
          contact,
          email,
          userId,
          deps.liveMode,
          now,
        );
      } catch (error) {
        done.failure = error;
        return [
          `Tried to check out ${what}, but the invoice couldn't be made. Nothing was charged.`,
        ];
      }
      const started = `Started checkout: ${what}, invoice ${done.invoice.number}`;
      return isGhlPayUrl(done.invoice.url)
        ? [started]
        : [`${started}. It was emailed; the site couldn't open its payment page.`];
    });
  } catch (error) {
    // The contact itself failed (no invoice was tried), or only the note did.
    if (!done.invoice) done.failure ??= error;
    else logGhlFailure(`Checkout note for site ${row.site.id}`, error);
  }
  const made = done.invoice;
  if (made && isGhlPayUrl(made.url)) {
    await countWithDeadline(deps, row, "delivered", now);
    return { status: 200, body: { ok: true, payUrl: made.url } };
  }
  if (made) {
    console.error(`Checkout for site ${row.site.id} failed: the invoice's address isn't GHL's`);
    await countWithDeadline(deps, row, "failed", now);
    return refuse(502, "We couldn't open the payment page. Your invoice is on its way by email.");
  }
  logGhlFailure(`Checkout for site ${row.site.id}`, done.failure);
  await countWithDeadline(deps, row, "failed", now);
  return refuse(502, NOT_STARTED);
}
