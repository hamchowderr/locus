CREATE TABLE `usage_alert` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`subject` text NOT NULL,
	`period` text NOT NULL,
	`threshold` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_alert_once` ON `usage_alert` (`organization_id`,`subject`,`period`,`threshold`);--> statement-breakpoint
CREATE TABLE `usage_event` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`location_id` text NOT NULL,
	`site_id` text,
	`actor_user_id` text,
	`kind` text NOT NULL,
	`credits` integer NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_event_location_created_idx` ON `usage_event` (`location_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_event_org_created_idx` ON `usage_event` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `usage_limit` (
	`location_id` text PRIMARY KEY NOT NULL,
	`monthly_credit_cap` integer,
	`alert_at_percent` integer DEFAULT 80 NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE cascade
);
