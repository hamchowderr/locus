CREATE TABLE IF NOT EXISTS `agency_trial` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`started_by_user_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ends_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agency_trial_started_by_user_id_unique` ON `agency_trial` (`started_by_user_id`);