CREATE TABLE IF NOT EXISTS `agency_onboarding` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`main_location_id` text,
	`github_skipped` integer DEFAULT false NOT NULL,
	`vercel_skipped` integer DEFAULT false NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`main_location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agency_onboarding_main_location_idx` ON `agency_onboarding` (`main_location_id`);
