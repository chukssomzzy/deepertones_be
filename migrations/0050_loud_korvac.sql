CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`local_day` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`link` text NOT NULL,
	`key` text NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_items_profile_key_unique` ON `inbox_items` (`profile_id`,`key`);--> statement-breakpoint
CREATE INDEX `inbox_items_profile_created_idx` ON `inbox_items` (`profile_id`,"created_at" desc);