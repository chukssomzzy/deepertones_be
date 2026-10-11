CREATE TABLE `job_runs` (
	`job` text NOT NULL,
	`key` text NOT NULL,
	`status` text NOT NULL,
	`lease_until` integer,
	`updated_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	PRIMARY KEY(`job`, `key`)
);
--> statement-breakpoint
CREATE INDEX `job_runs_updated_at_idx` ON `job_runs` (`updated_at`);