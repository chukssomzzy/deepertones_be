ALTER TABLE `products` ADD `form` text;--> statement-breakpoint
ALTER TABLE `scan_items` ADD `recognised_form` text;--> statement-breakpoint
update products set identity_key = identity_key || '|';--> statement-breakpoint
update product_aliases set alias_key = alias_key || '|';
