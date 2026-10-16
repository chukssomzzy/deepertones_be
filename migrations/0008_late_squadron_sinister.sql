CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`estimate_micros` integer NOT NULL,
	`cost_micros` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_write_tokens` integer,
	`cache_read_tokens` integer,
	`web_searches` integer,
	`created_at` integer NOT NULL,
	`settled_at` integer
);
--> statement-breakpoint
CREATE INDEX `ai_usage_created_at_idx` ON `ai_usage` (`created_at`);