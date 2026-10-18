CREATE TABLE `scan_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`position` integer NOT NULL,
	`state` text DEFAULT 'recognising' NOT NULL,
	`photo_key` text,
	`recognition` text,
	`skipped_not_beauty` integer DEFAULT 0 NOT NULL,
	`skipped_unreadable` integer DEFAULT 0 NOT NULL,
	`skipped_over_limit` integer DEFAULT 0 NOT NULL,
	`skipped_daily_limit` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_photos_scan_id_position_idx` ON `scan_photos` (`scan_id`,`position`);--> statement-breakpoint
CREATE INDEX `scan_photos_user_id_idx` ON `scan_photos` (`user_id`);--> statement-breakpoint
ALTER TABLE `scan_items` ADD `photo_id` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `kind` text;