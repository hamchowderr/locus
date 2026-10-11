-- Better Auth's generated schema leaves the Stripe plugin's lookup columns unindexed, and
-- auth-schema.ts is generated, so the indexes live here. Turso bills rows scanned: entitlement
-- reads subscriptions by agency on every gated request, and the webhook finds the agency and
-- the subscription by their Stripe ids.
CREATE INDEX `subscription_referenceId_idx` ON `subscription` (`reference_id`);--> statement-breakpoint
CREATE INDEX `subscription_stripeSubscriptionId_idx` ON `subscription` (`stripe_subscription_id`);--> statement-breakpoint
CREATE INDEX `organization_stripeCustomerId_idx` ON `organization` (`stripe_customer_id`);--> statement-breakpoint
CREATE INDEX `user_stripeCustomerId_idx` ON `user` (`stripe_customer_id`);
