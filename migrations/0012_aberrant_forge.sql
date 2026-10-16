ALTER TABLE `scans` ADD `profile_id` text;--> statement-breakpoint
UPDATE `scans` SET `profile_id` = (SELECT `profiles`.`id` FROM `profiles` WHERE `profiles`.`user_id` = `scans`.`user_id` AND `profiles`.`is_default` = 1);--> statement-breakpoint
CREATE INDEX `scans_profile_id_created_at_idx` ON `scans` (`profile_id`,`created_at`);
