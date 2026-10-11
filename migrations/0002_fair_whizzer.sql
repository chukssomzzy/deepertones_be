ALTER TABLE `otp_challenges` ADD `delivery_status` text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE `otp_challenges` ADD `failure_reason` text;--> statement-breakpoint
ALTER TABLE `otp_challenges` ADD `delivered_at` integer;