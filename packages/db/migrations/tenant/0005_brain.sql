CREATE TABLE `brain_file` (
	`path` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `brain_file_version` (
	`path` text NOT NULL,
	`number` integer NOT NULL,
	`content` text,
	`created_at` integer NOT NULL,
	`created_by` text,
	PRIMARY KEY(`path`, `number`)
);
