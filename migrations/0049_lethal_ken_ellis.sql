ALTER TABLE `reminder_settings` ADD `enabled_on` text;--> statement-breakpoint
-- Rows that already have reminders on count from the day of this migration (UTC), so none of them is nudged at once for days missed before it.
UPDATE `reminder_settings` SET `enabled_on` = date('now') WHERE `enabled` = 1;
