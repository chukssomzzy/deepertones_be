CREATE TABLE `routine_requests` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`requested_at` integer NOT NULL,
	`retry_due_at` integer,
	`retried` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routine_requests_retry_due_idx` ON `routine_requests` (`retry_due_at`) WHERE "routine_requests"."retry_due_at" IS NOT NULL;