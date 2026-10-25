CREATE TABLE `claim_words` (
	`code` text PRIMARY KEY NOT NULL,
	`phrase` text NOT NULL,
	`claim` text NOT NULL,
	`status` text NOT NULL,
	`approved_by` text,
	`approved_on` text,
	`audited_by` text,
	`audited_on` text,
	`updated_in_version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tapers` (
	`code` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`schedule` text NOT NULL,
	`what_to_expect` text NOT NULL,
	`see_a_professional_if` text NOT NULL,
	`status` text NOT NULL,
	`approved_by` text,
	`approved_on` text,
	`audited_by` text,
	`audited_on` text,
	`updated_in_version` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ingredient_rules` ADD `group` text;--> statement-breakpoint
ALTER TABLE `ingredient_rules` ADD `clashes_with` text DEFAULT '[]' NOT NULL;