CREATE TABLE IF NOT EXISTS `brain_auto_save` (
	`location_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE cascade
);
