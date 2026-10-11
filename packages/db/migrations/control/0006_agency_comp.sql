CREATE TABLE `agency_comp` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`comped_by_user_id` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
