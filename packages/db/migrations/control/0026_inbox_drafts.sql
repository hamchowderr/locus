CREATE TABLE IF NOT EXISTS `inbox_drafts` (
	`location_id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `inbox_drafts_member_idx` ON `inbox_drafts` (`member_id`);