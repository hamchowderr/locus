CREATE TABLE `generation_run` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `site_file` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_file_path_version` ON `site_file` (`path`,`version`);--> statement-breakpoint
CREATE TABLE `site_version` (
	`version` integer PRIMARY KEY NOT NULL,
	`commit_sha` text,
	`message` text,
	`created_at` integer NOT NULL
);
