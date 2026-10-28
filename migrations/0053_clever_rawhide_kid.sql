CREATE TABLE `step_pauses` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`step` text,
	`product_key` text NOT NULL,
	`product_id` text,
	`product_ref` text NOT NULL,
	`ingredient_group` text,
	`state` text NOT NULL,
	`paused_on` text NOT NULL,
	`check_day` text NOT NULL,
	`same_count` integer NOT NULL,
	`source_log_id` text,
	`ladder_code` text,
	`ladder_started_on` text,
	`version_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `step_pauses_open_step_product_unique` ON `step_pauses` (`profile_id`,`step`,`product_key`) WHERE "step_pauses"."step" IS NOT NULL AND "step_pauses"."state" IN ('paused', 'bringing-back');--> statement-breakpoint
CREATE UNIQUE INDEX `step_pauses_open_stepless_unique` ON `step_pauses` (`profile_id`) WHERE "step_pauses"."step" IS NULL AND "step_pauses"."state" IN ('paused', 'bringing-back');--> statement-breakpoint
CREATE INDEX `step_pauses_profile_created_idx` ON `step_pauses` (`profile_id`,`created_at`);