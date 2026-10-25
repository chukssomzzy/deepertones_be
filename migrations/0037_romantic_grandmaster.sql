CREATE TABLE `shelf_verdicts` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`fingerprint` text NOT NULL,
	`requested_at` integer NOT NULL,
	`fit` text,
	`products` text NOT NULL,
	`built_at` integer,
	`rules_version` text,
	`catalog_version` integer,
	`model` text,
	`prompt_hash` text,
	`inputs` text,
	`fit_attempts` integer DEFAULT 0 NOT NULL,
	`fit_retried` integer DEFAULT false NOT NULL,
	`fit_retry_due_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shelf_verdicts_fit_retry_due_idx` ON `shelf_verdicts` (`fit_retry_due_at`) WHERE "shelf_verdicts"."fit_retry_due_at" IS NOT NULL;