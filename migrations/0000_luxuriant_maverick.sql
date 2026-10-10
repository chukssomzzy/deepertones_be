CREATE TABLE `otp_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `otp_challenges_phone_created_at_idx` ON `otp_challenges` (`phone`,`created_at`);