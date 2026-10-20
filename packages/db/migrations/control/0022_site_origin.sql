ALTER TABLE `site` ADD `origin` text DEFAULT 'studio' NOT NULL;--> statement-breakpoint
-- Rows from before this column: a host project without a repository was made by linking.
UPDATE `site` SET `origin` = 'linked' WHERE `host_project_id` IS NOT NULL AND `repo_full_name` IS NULL;
