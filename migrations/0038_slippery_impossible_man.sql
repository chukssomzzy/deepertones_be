CREATE TABLE `routine_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`steps` text NOT NULL,
	`tapers` text NOT NULL,
	`expectation` text,
	`started_on` integer,
	`served_at` integer,
	`model` text,
	`prompt_hash` text,
	`catalog_version` integer,
	`rules_version` text NOT NULL,
	`hints_shown` integer NOT NULL,
	`verdict_fingerprint` text NOT NULL,
	`routine_fingerprint` text,
	`source` text,
	`reason` text NOT NULL,
	`writer_retry_due_at` integer,
	`writer_calls` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routine_versions_profile_created_idx` ON `routine_versions` (`profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `routine_versions_writer_retry_due_idx` ON `routine_versions` (`writer_retry_due_at`) WHERE "routine_versions"."writer_retry_due_at" IS NOT NULL;