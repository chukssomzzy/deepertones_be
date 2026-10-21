CREATE TABLE `profile_shopping` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`country` text NOT NULL,
	`budget_band` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_shopping_profile_id_created_at_idx` ON `profile_shopping` (`profile_id`,`created_at`);