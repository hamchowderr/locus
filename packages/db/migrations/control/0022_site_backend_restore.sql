CREATE TABLE IF NOT EXISTS `site_backend_restore` (
	`site_id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`current_since` integer NOT NULL,
	`kept_db_name` text,
	`kept_db_hostname` text,
	`kept_since` integer,
	`restored_to` integer,
	`restored_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `site`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_backend_restore_kept_db_name_unique` ON `site_backend_restore` (`kept_db_name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_backend_restore_location_idx` ON `site_backend_restore` (`location_id`);