CREATE TABLE `usage_overage` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`monthly_credit_limit` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `usage_event` ADD `overage_credits` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_event` ADD `overage_reported_at` integer;--> statement-breakpoint
CREATE INDEX `usage_event_overage_unreported_idx` ON `usage_event` (`created_at`) WHERE "usage_event"."overage_credits" > 0 and "usage_event"."overage_reported_at" is null;--> statement-breakpoint
ALTER TABLE `usage_month` ADD `overage_credits` integer DEFAULT 0 NOT NULL;