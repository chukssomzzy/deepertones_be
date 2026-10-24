CREATE TABLE `face_check_in_pushes` (
	`profile_id` text NOT NULL,
	`user_id` text NOT NULL,
	`goal` text NOT NULL,
	`day_one_scan_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `day_one_scan_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `face_check_in_pushes_user_id_idx` ON `face_check_in_pushes` (`user_id`);