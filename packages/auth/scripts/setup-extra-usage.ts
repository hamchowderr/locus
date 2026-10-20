// Creates the Stripe meter and metered price that bill agencies' extra usage, once per Stripe
// account (test and live mode each). Safe to run again.
//   infisical run --env=dev --path=/locus -- node packages/auth/scripts/setup-extra-usage.ts
import { createStripe, setupOverageBilling } from "../src/index.ts";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
const { meter, price, created } = await setupOverageBilling(createStripe(key));
console.log(
  `${price.livemode ? "live" : "test"} mode: meter ${meter.id}, price ${price.id}` +
    (created.length ? ` (created ${created.join(", ")})` : " (already set up)"),
);
