CREATE TABLE `secret` (
	`path` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL,
	`updated_at` integer NOT NULL
);
