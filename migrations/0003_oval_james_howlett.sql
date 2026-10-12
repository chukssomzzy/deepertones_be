-- SQLite cannot add a NOT NULL column without a default, so the table is rebuilt. It is empty in every
-- environment (OTP was never deployed), so nothing is copied. Edited by hand after drizzle-kit generated it.
DROP TABLE `otp_challenges`;--> statement-breakpoint
CREATE TABLE `otp_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`address` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer,
	`delivery_status` text DEFAULT 'queued' NOT NULL,
	`failure_reason` text,
	`delivered_at` integer
);--> statement-breakpoint
CREATE INDEX `otp_challenges_recipient_created_at_idx` ON `otp_challenges` (`channel`,`address`,`created_at`);
