CREATE TABLE IF NOT EXISTS `site_builder_off` (
	`location_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `site_member_role` (
	`site_id` text NOT NULL,
	`member_id` text NOT NULL,
	`level` text NOT NULL,
	PRIMARY KEY(`site_id`, `member_id`),
	FOREIGN KEY (`site_id`) REFERENCES `site`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_member_role_member_idx` ON `site_member_role` (`member_id`);