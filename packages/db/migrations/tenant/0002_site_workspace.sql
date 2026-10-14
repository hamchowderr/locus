CREATE TABLE `generation_run` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`thread_id` text,
	`prompt` text NOT NULL,
	`status` text NOT NULL,
	`version_id` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `generation_run_site_idx` ON `generation_run` (`site_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `site_blob` (
	`hash` text PRIMARY KEY NOT NULL,
	`encoding` text NOT NULL,
	`content` text NOT NULL,
	`size` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_brief` (
	`site_id` text PRIMARY KEY NOT NULL,
	`brief` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_draft_file` (
	`site_id` text NOT NULL,
	`path` text NOT NULL,
	`blob_hash` text NOT NULL,
	PRIMARY KEY(`site_id`, `path`),
	FOREIGN KEY (`blob_hash`) REFERENCES `site_blob`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `site_draft_file_blob_idx` ON `site_draft_file` (`blob_hash`);--> statement-breakpoint
CREATE TABLE `site_version` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`number` integer NOT NULL,
	`message` text NOT NULL,
	`source` text NOT NULL,
	`parent_id` text,
	`bookmarked` integer DEFAULT false NOT NULL,
	`commit_sha` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_version_site_number` ON `site_version` (`site_id`,`number`);--> statement-breakpoint
CREATE TABLE `site_version_file` (
	`version_id` text NOT NULL,
	`path` text NOT NULL,
	`blob_hash` text NOT NULL,
	PRIMARY KEY(`version_id`, `path`),
	FOREIGN KEY (`version_id`) REFERENCES `site_version`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blob_hash`) REFERENCES `site_blob`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `site_version_file_blob_idx` ON `site_version_file` (`blob_hash`);