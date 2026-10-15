CREATE TABLE `analysis_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`formulation_id` text NOT NULL,
	`attempted_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`analysis_version` integer NOT NULL,
	`reference_version` text NOT NULL,
	FOREIGN KEY (`formulation_id`) REFERENCES `formulations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `analysis_attempts_attempted_at_idx` ON `analysis_attempts` (`attempted_at`);--> statement-breakpoint
CREATE INDEX `analysis_attempts_formulation_id_idx` ON `analysis_attempts` (`formulation_id`);--> statement-breakpoint
DROP INDEX `formulations_product_id_ingredients_key_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `formulations_product_id_ingredients_key_idx` ON `formulations` (`product_id`,`ingredients_key`);