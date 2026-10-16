CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text,
	`is_default` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_user_id_default_idx` ON `profiles` (`user_id`) WHERE "profiles"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `profiles_user_id_idx` ON `profiles` (`user_id`);--> statement-breakpoint
INSERT INTO `profiles` (`id`, `user_id`, `display_name`, `is_default`, `created_at`)
SELECT lower(hex(randomblob(16))), `id`, NULL, 1, `created_at` FROM `users`;
