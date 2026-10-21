CREATE TABLE `face_consents` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`version` integer NOT NULL,
	`given_at` integer NOT NULL,
	`withdrawn_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `face_consents_user_id_idx` ON `face_consents` (`user_id`);--> statement-breakpoint
CREATE TABLE `face_masks` (
	`face_scan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`concern` text NOT NULL,
	`mask_key` text NOT NULL,
	PRIMARY KEY(`face_scan_id`, `concern`),
	FOREIGN KEY (`face_scan_id`) REFERENCES `face_scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `face_masks_user_id_idx` ON `face_masks` (`user_id`);--> statement-breakpoint
CREATE TABLE `face_results` (
	`face_scan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`concern` text NOT NULL,
	`region` text NOT NULL,
	`raw_score` real NOT NULL,
	`ui_score` real NOT NULL,
	PRIMARY KEY(`face_scan_id`, `concern`, `region`),
	FOREIGN KEY (`face_scan_id`) REFERENCES `face_scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `face_results_user_id_idx` ON `face_results` (`user_id`);--> statement-breakpoint
CREATE TABLE `face_scan_photos` (
	`face_scan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`position` text NOT NULL,
	`photo_key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`face_scan_id`, `position`),
	FOREIGN KEY (`face_scan_id`) REFERENCES `face_scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `face_scan_photos_user_id_idx` ON `face_scan_photos` (`user_id`);--> statement-breakpoint
CREATE TABLE `face_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`state` text DEFAULT 'analysing' NOT NULL,
	`reason` text,
	`goal_at_scan` text NOT NULL,
	`pc_analysis_task_id` text,
	`pc_fitzpatrick_task_id` text,
	`pc_environment` text,
	`skin_age` integer,
	`skin_type` text,
	`tables_version` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `face_scans_profile_id_created_at_idx` ON `face_scans` (`profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `face_scans_user_id_idx` ON `face_scans` (`user_id`);--> statement-breakpoint
CREATE TABLE `profile_fitzpatrick` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`fitzpatrick` text NOT NULL,
	`task_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_fitzpatrick_user_id_idx` ON `profile_fitzpatrick` (`user_id`);