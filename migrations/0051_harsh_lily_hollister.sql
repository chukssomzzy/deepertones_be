CREATE TABLE `escalations` (
	`key` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`who_to_see` text NOT NULL,
	`how_soon` text NOT NULL,
	`what_to_tell_them` text NOT NULL,
	`status` text NOT NULL,
	`approved_by` text,
	`approved_on` text,
	`audited_by` text,
	`audited_on` text,
	`updated_in_version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reintroductions` (
	`key` text PRIMARY KEY NOT NULL,
	`group` text,
	`schedule` text NOT NULL,
	`status` text NOT NULL,
	`approved_by` text,
	`approved_on` text,
	`audited_by` text,
	`audited_on` text,
	`updated_in_version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `responses` (
	`key` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`what_to_do_now` text,
	`status` text NOT NULL,
	`approved_by` text,
	`approved_on` text,
	`audited_by` text,
	`audited_on` text,
	`updated_in_version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `weeks` (
	`key` text PRIMARY KEY NOT NULL,
	`band` text NOT NULL,
	`goal` text,
	`step_down` integer NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`approved_by` text,
	`approved_on` text,
	`audited_by` text,
	`audited_on` text,
	`updated_in_version` integer NOT NULL
);
