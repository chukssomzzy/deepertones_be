CREATE TABLE `reminder_settings` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`morning` text DEFAULT '07:00' NOT NULL,
	`evening` text DEFAULT '21:00' NOT NULL,
	`time_zone` text,
	`step_down_alerts` integer DEFAULT true NOT NULL,
	`missed_days_nudge` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
