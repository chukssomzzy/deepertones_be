CREATE TABLE `profile_safety` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`choices` text NOT NULL,
	`reaction_text` text,
	`prescription_text` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_safety_profile_id_created_at_idx` ON `profile_safety` (`profile_id`,`created_at`);