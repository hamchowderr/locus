CREATE TABLE `site_member_access` (
	`site_id` text NOT NULL,
	`member_id` text NOT NULL,
	`level` text NOT NULL,
	PRIMARY KEY(`site_id`, `member_id`),
	FOREIGN KEY (`site_id`) REFERENCES `site`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_member_access_member_idx` ON `site_member_access` (`member_id`);--> statement-breakpoint
ALTER TABLE `location` ADD `site_builder` integer DEFAULT true NOT NULL;