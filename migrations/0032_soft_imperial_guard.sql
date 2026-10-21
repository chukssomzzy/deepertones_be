CREATE TABLE `countries` (
	`code` text PRIMARY KEY NOT NULL,
	`currency` text NOT NULL,
	`low_max` integer NOT NULL,
	`mid_max` integer NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_availability` (
	`product_code` text NOT NULL,
	`country` text NOT NULL,
	`price_min` integer NOT NULL,
	`price_max` integer NOT NULL,
	`where_sold` text,
	`source_url` text,
	PRIMARY KEY(`product_code`, `country`),
	FOREIGN KEY (`product_code`) REFERENCES `recommended_products`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`country`) REFERENCES `countries`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `product_availability_country_idx` ON `product_availability` (`country`);--> statement-breakpoint
CREATE TABLE `recommended_products` (
	`code` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`formulation_id` text,
	`brand` text NOT NULL,
	`name` text NOT NULL,
	`variant` text,
	`form` text,
	`category` text NOT NULL,
	`ingredients` text NOT NULL,
	`ingredients_source_url` text,
	`skin_concerns` text NOT NULL,
	`skin_types` text NOT NULL,
	`steps` text NOT NULL,
	`frequency` text NOT NULL,
	`own_cautions` text NOT NULL,
	`evidence_urls` text NOT NULL,
	`origin` text NOT NULL,
	`status` text NOT NULL,
	`approved_by` text,
	`approved_on` text,
	`audited_by` text,
	`audited_on` text,
	`draft_cells` text NOT NULL,
	`updated_in_version` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`formulation_id`) REFERENCES `formulations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recommended_products_product_id_idx` ON `recommended_products` (`product_id`);