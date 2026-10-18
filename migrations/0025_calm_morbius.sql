CREATE TABLE `profile_products` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`product_id` text,
	`formulation_id` text,
	`scan_id` text NOT NULL,
	`item_id` text NOT NULL,
	`added_at` integer NOT NULL,
	`last_scanned_at` integer NOT NULL,
	`removed_at` integer,
	`removed_reason` text,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_products_profile_id_product_id_uniq` ON `profile_products` (`profile_id`,`product_id`) WHERE "profile_products"."product_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `profile_products_item_id_no_label_uniq` ON `profile_products` (`item_id`) WHERE "profile_products"."product_id" IS NULL;--> statement-breakpoint
CREATE INDEX `profile_products_profile_id_last_scanned_at_idx` ON `profile_products` (`profile_id`,`last_scanned_at`);