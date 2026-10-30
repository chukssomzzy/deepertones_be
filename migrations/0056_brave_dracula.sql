CREATE TABLE `face_share_consents` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`version` integer NOT NULL,
	`given_at` integer NOT NULL,
	`withdrawn_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `face_share_consents_user_id_idx` ON `face_share_consents` (`user_id`);--> statement-breakpoint
CREATE TABLE `face_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`before_scan_id` text NOT NULL,
	`after_scan_id` text NOT NULL,
	`consent_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `face_shares_profile_id_created_at_idx` ON `face_shares` (`profile_id`,`created_at`);