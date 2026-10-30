CREATE TABLE `verdict_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`kind` text NOT NULL,
	`group` text,
	`verdict` text,
	`basis` text,
	`fingerprint` text,
	`note` text,
	`old_product_id` text,
	`new_product_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verdict_reports_mistake_unique` ON `verdict_reports` (`profile_id`,`entry_id`,`fingerprint`) WHERE "verdict_reports"."kind" = 'mistake';