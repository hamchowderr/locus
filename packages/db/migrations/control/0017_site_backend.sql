CREATE TABLE `site_backend` (
	`site_id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`turso_db_name` text NOT NULL,
	`turso_db_hostname` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `site`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_backend_turso_db_name_unique` ON `site_backend` (`turso_db_name`);--> statement-breakpoint
CREATE INDEX `site_backend_location_idx` ON `site_backend` (`location_id`);