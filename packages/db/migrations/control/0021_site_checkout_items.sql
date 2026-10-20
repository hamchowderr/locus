CREATE TABLE IF NOT EXISTS `site_checkout_items` (
	`site_id` text PRIMARY KEY NOT NULL,
	`items` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `site`(`id`) ON UPDATE no action ON DELETE cascade
);
