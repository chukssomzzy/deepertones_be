CREATE TABLE `profile_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`text` text,
	`goal` text,
	`wants_lighter` integer NOT NULL,
	`answers_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_goals_profile_id_created_at_idx` ON `profile_goals` (`profile_id`,`created_at`);