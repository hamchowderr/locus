CREATE TABLE `usage_month` (
	`location_id` text NOT NULL,
	`month` text NOT NULL,
	`organization_id` text NOT NULL,
	`credits` integer NOT NULL,
	PRIMARY KEY(`location_id`, `month`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_month_org_month_idx` ON `usage_month` (`organization_id`,`month`);