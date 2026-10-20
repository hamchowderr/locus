CREATE TABLE `app_access` (
	`toolkit` text PRIMARY KEY NOT NULL,
	`access` text NOT NULL,
	`updated_by_user_id` text,
	`updated_at` integer NOT NULL
);
