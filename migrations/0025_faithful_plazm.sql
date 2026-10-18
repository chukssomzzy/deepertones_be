CREATE TABLE `safety_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`safety_id` text NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`brand` text,
	`name` text NOT NULL,
	`variant` text,
	`category` text,
	`product_id` text,
	`resolution` text,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`safety_id`) REFERENCES `profile_safety`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `safety_mentions_safety_id_position_idx` ON `safety_mentions` (`safety_id`,`position`);--> statement-breakpoint
CREATE TABLE `safety_reads` (
	`safety_id` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`safety_id`, `source`),
	FOREIGN KEY (`safety_id`) REFERENCES `profile_safety`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `profile_safety` ADD `parse_state` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `profile_safety` ADD `parse_due_at` integer;--> statement-breakpoint
ALTER TABLE `profile_safety` ADD `parse_retried` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `profile_safety_pending_due_idx` ON `profile_safety` (`parse_due_at`) WHERE "profile_safety"."parse_state" = 'pending';