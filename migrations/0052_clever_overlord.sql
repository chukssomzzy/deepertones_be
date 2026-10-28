CREATE TABLE `skin_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`noticing` text NOT NULL,
	`where` text NOT NULL,
	`how_bad` text,
	`note` text,
	`local_day` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`rules_version` integer NOT NULL,
	`overridden` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skin_logs_profile_created_idx` ON `skin_logs` (`profile_id`,`created_at`);