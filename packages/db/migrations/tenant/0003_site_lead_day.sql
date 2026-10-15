CREATE TABLE `site_lead_day` (
	`site_id` text NOT NULL,
	`day` text NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `day`)
);
