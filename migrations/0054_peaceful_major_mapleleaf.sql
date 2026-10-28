CREATE TABLE `escalation_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`reason` text NOT NULL,
	`source_log_id` text,
	`opened_on` text NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`closed_how` text,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `escalation_holds_open_profile_unique` ON `escalation_holds` (`profile_id`) WHERE "escalation_holds"."closed_at" IS NULL;