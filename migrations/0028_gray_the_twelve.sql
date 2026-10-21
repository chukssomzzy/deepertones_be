ALTER TABLE `ai_usage` ADD `vendor` text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `units` integer;