CREATE TABLE `scan_retakes` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`user_id` text NOT NULL,
	`ip_hash` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `scan_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scan_retakes_user_id_uploaded_at_idx` ON `scan_retakes` (`user_id`,`uploaded_at`);--> statement-breakpoint
CREATE INDEX `scan_retakes_ip_hash_uploaded_at_idx` ON `scan_retakes` (`ip_hash`,`uploaded_at`);