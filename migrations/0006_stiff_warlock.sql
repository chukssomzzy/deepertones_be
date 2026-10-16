CREATE TABLE `concern_traits` (
	`concern_id` text NOT NULL,
	`trait` text NOT NULL,
	PRIMARY KEY(`concern_id`, `trait`),
	FOREIGN KEY (`concern_id`) REFERENCES `formulation_concerns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `formulation_concerns` (
	`id` text PRIMARY KEY NOT NULL,
	`formulation_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`ingredients` text NOT NULL,
	`why` text NOT NULL,
	`who_should_take_care` text NOT NULL,
	`sources` text NOT NULL,
	FOREIGN KEY (`formulation_id`) REFERENCES `formulations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `formulation_concerns_formulation_id_position_idx` ON `formulation_concerns` (`formulation_id`,`position`);--> statement-breakpoint
CREATE TABLE `formulations` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`ingredients` text NOT NULL,
	`ingredients_key` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_url` text,
	`found_at` integer NOT NULL,
	`analysis_version` integer,
	`reference_version` text,
	`analysed_at` integer,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `formulations_product_id_found_at_idx` ON `formulations` (`product_id`,`found_at`);--> statement-breakpoint
CREATE INDEX `formulations_product_id_ingredients_key_idx` ON `formulations` (`product_id`,`ingredients_key`);--> statement-breakpoint
CREATE TABLE `product_aliases` (
	`alias_key` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_aliases_product_id_idx` ON `product_aliases` (`product_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_key` text NOT NULL,
	`brand_key` text NOT NULL,
	`brand` text NOT NULL,
	`name` text NOT NULL,
	`variant` text,
	`category` text NOT NULL,
	`image_key` text,
	`image_source_url` text,
	`image_checked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_identity_key_idx` ON `products` (`identity_key`);--> statement-breakpoint
CREATE INDEX `products_brand_key_created_at_idx` ON `products` (`brand_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `research_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text,
	`attempted_at` integer NOT NULL,
	`outcome` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `research_attempts_attempted_at_idx` ON `research_attempts` (`attempted_at`);