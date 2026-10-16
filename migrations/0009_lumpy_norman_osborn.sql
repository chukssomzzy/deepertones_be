CREATE TABLE `scan_back_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`user_id` text NOT NULL,
	`ip_hash` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `scan_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scan_back_photos_user_id_uploaded_at_idx` ON `scan_back_photos` (`user_id`,`uploaded_at`);--> statement-breakpoint
CREATE INDEX `scan_back_photos_ip_hash_uploaded_at_idx` ON `scan_back_photos` (`ip_hash`,`uploaded_at`);--> statement-breakpoint
CREATE TABLE `scan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`position` integer NOT NULL,
	`state` text DEFAULT 'recognising' NOT NULL,
	`reason` text,
	`photo_key` text,
	`back_photo_key` text,
	`recognised_brand` text,
	`recognised_name` text,
	`recognised_variant` text,
	`recognised_category` text,
	`recognised_confidence` real,
	`product_id` text,
	`formulation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_items_scan_id_position_idx` ON `scan_items` (`scan_id`,`position`);--> statement-breakpoint
CREATE INDEX `scan_items_user_id_created_at_idx` ON `scan_items` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scan_items_state_updated_at_idx` ON `scan_items` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`done_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scans_user_id_idx` ON `scans` (`user_id`);--> statement-breakpoint
CREATE INDEX `scans_ip_hash_created_at_idx` ON `scans` (`ip_hash`,`created_at`);